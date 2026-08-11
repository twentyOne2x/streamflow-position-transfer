import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  WalletCards,
} from "lucide-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  MessageV0,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import {
  Contract,
  ICluster,
  SolanaStreamClient,
  decodeStream,
  type Stream,
} from "@streamflow/stream";
import {
  bytesEqual,
  decidePendingRecovery,
  enforceSimulatedPayerDebit,
  semanticTransactionDigest,
  sha256Hex,
  validateCompiledTransferMessage,
  validateDestinationWallet,
  validateTransferInstructions,
} from "./transactionSafety";
import {
  REQUIRED_STREAM_FIELDS,
  assertRecipientOnlyTransition,
  snapshotStream,
  type StreamInvariant,
} from "./streamState";
import {
  EXPECTED_MAINNET_GENESIS_HASH,
  EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256,
  MAX_TOTAL_COST_LAMPORTS,
  RAW_RECIPIENT_END,
  RAW_RECIPIENT_START,
  STREAMFLOW_V4_ACCOUNT_BYTES,
  STREAMFLOW_V4_PROGRAM_ID,
  appendFinalizedTransferReceipt,
  assertRawRecipientOnlyTransition,
  decodeCanonicalBase64,
  parseFinalizedTransferReceipts,
  rawChangedBytesEqual,
  type FinalizedTransferReceipt,
} from "./positionTransferSafety";
import {
  assertDestinationTokenAccountUsable,
  assertNewDestinationTokenAccountUsable,
  getDestinationAtaSize,
} from "./tokenAccountSafety";
import { formatTokenAmount } from "./tokenAmount";
import { verifyFinalizedTransferReceipt } from "./receiptVerification";
import {
  BROADCAST_LOCK_KEY,
  PENDING_BROADCAST_KEY,
  PENDING_PREPARED_KEY,
  assertArmedTransferUnchanged,
  discardPreparedTransfer,
  hasTransferJournalRecord,
  isFinalizedStatus,
  prepareAndArmTransfer,
  readTransferJournal,
  requireFinalizedBaselineBeforeExpiryClear,
} from "./pendingTransferJournal";

const STREAMFLOW_PROGRAM_ID = new PublicKey(STREAMFLOW_V4_PROGRAM_ID);
const UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MIN_BLOCKHEIGHT_MARGIN = 20;
const MAX_CONTEXT_SLOT_DRIFT = 150;
const FINALIZED_RECEIPTS_KEY = "streamflow-position-transfer.receipts.v1";
const PENDING_POLL_INTERVAL_MS = 2_000;
const RECOVERY_REBROADCAST_INTERVAL_MS = 10_000;

type Preflight = {
  contractId: string;
  source: string;
  destination: string;
  mint: string;
  amount: string;
  streamType: string;
  recipientTransferable: boolean;
  senderTransferable: boolean;
  tokenProgram: string;
  checkedAt: string;
  instructionPrograms: string[];
  unitsConsumed: number;
  feeLamports: number;
  ataRentLamports: number;
  simulatedPayerDebitLamports: number;
  estimatedTotalLamports: number;
  semanticDigest: string;
  messageSha256: string;
  contractReadSlot: number;
  blockhashContextSlot: number;
  destinationClassification: string;
  destinationBalanceLamports: number;
  destinationChallenge: string;
  programDataSha256: string;
  destinationAta: string;
  streamBefore: StreamInvariant;
  streamLamportsBefore: number;
  streamRawBeforeBase64: string;
  streamRawBeforeSha256: string;
  simulatedStreamRawAfterSha256: string;
  simulatedRawChangedBytes: number[];
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
};

type Receipt = FinalizedTransferReceipt;

type SignedTransfer = Preflight & {
  signedAt: string;
  wireTransaction: Uint8Array;
  expectedSignature: string;
  signedMessageSha256: string;
  signedWireSha256: string;
};

type PendingBroadcast = {
  schema: "streamflow-position-transfer.pending.v1";
  expectedSignature: string;
  contractId: string;
  source: string;
  destination: string;
  destinationAta: string;
  mint: string;
  tokenProgram: string;
  blockhash: string;
  contractReadSlot: number;
  blockhashContextSlot: number;
  lastValidBlockHeight: number;
  feeLamports: number;
  ataRentLamports: number;
  simulatedPayerDebitLamports: number;
  semanticDigest: string;
  signedMessageSha256: string;
  signedWireSha256: string;
  wireBase64: string;
  programDataSha256: string;
  streamBefore: StreamInvariant;
  streamLamportsBefore: number;
  streamRawBeforeBase64: string;
  streamRawBeforeSha256: string;
  simulatedStreamRawAfterSha256: string;
  simulatedRawChangedBytes: number[];
  savedAt: string;
};

type DestinationProof = {
  destination: string;
  challengeSha256: string;
  signature: string;
};

function shorten(value: string, edge = 6) {
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function formatRemaining(stream: Stream, decimals: number) {
  const raw = BigInt(stream.depositedAmount.toString()) - BigInt(stream.withdrawnAmount.toString());
  return formatTokenAmount(raw, decimals);
}

function decodeOnchainStream(data: Buffer): Stream {
  return new Contract(decodeStream(data)) as Stream;
}

function decodeSimulatedAccountData(data: string[], label: string) {
  if (data.length !== 2 || data[1] !== "base64") {
    throw new Error(`${label} did not return base64 account data.`);
  }
  return decodeCanonicalBase64(data[0], label);
}

async function assertRetainedRawBaseline({
  current,
  retainedBase64,
  retainedSha256,
}: {
  current: Uint8Array;
  retainedBase64: string;
  retainedSha256: string;
}) {
  const retained = decodeCanonicalBase64(retainedBase64, "Retained Streamflow baseline");
  if (retained.length !== STREAMFLOW_V4_ACCOUNT_BYTES || current.length !== STREAMFLOW_V4_ACCOUNT_BYTES) {
    throw new Error(`Streamflow contract data must remain exactly ${STREAMFLOW_V4_ACCOUNT_BYTES} bytes.`);
  }
  if ((await sha256Hex(retained)) !== retainedSha256) {
    throw new Error("Retained Streamflow baseline does not match its digest.");
  }
  if (!bytesEqual(current, retained)) throw new Error("Streamflow contract raw state changed after review.");
  return retained;
}

function parsePendingBroadcast(serialized: string): PendingBroadcast {
  const value = JSON.parse(serialized) as Partial<PendingBroadcast>;
  if (
    value.schema !== "streamflow-position-transfer.pending.v1" ||
    typeof value.expectedSignature !== "string" ||
    typeof value.contractId !== "string" ||
    typeof value.source !== "string" ||
    typeof value.destination !== "string" ||
    typeof value.destinationAta !== "string" ||
    typeof value.mint !== "string" ||
    typeof value.tokenProgram !== "string" ||
    typeof value.blockhash !== "string" ||
    typeof value.contractReadSlot !== "number" ||
    typeof value.blockhashContextSlot !== "number" ||
    typeof value.lastValidBlockHeight !== "number" ||
    typeof value.feeLamports !== "number" ||
    typeof value.ataRentLamports !== "number" ||
    typeof value.simulatedPayerDebitLamports !== "number" ||
    typeof value.semanticDigest !== "string" ||
    typeof value.signedMessageSha256 !== "string" ||
    typeof value.signedWireSha256 !== "string" ||
    typeof value.wireBase64 !== "string" ||
    typeof value.programDataSha256 !== "string" ||
    !value.streamBefore ||
    typeof value.streamBefore !== "object" ||
    typeof value.streamLamportsBefore !== "number" ||
    typeof value.streamRawBeforeBase64 !== "string" ||
    typeof value.streamRawBeforeSha256 !== "string" ||
    typeof value.simulatedStreamRawAfterSha256 !== "string" ||
    !Array.isArray(value.simulatedRawChangedBytes) ||
    typeof value.savedAt !== "string"
  ) {
    throw new Error("The retained pending transfer record is invalid.");
  }
  return value as PendingBroadcast;
}

function hasRetainedPendingRecord() {
  return hasTransferJournalRecord(window.localStorage);
}

function loadPendingBroadcast() {
  const snapshot = readTransferJournal(window.localStorage, parsePendingBroadcast);
  if (snapshot.phase === "armed") {
    return { pending: snapshot.value, preparedPresent: false, error: null };
  }
  if (snapshot.phase === "prepared") {
    return { pending: null, preparedPresent: true, error: null };
  }
  if (snapshot.phase === "invalid") {
    return {
      pending: null,
      preparedPresent: false,
      error: "A pending transfer record failed validation and remains quarantined. New transfers are blocked.",
    };
  }
  return { pending: null, preparedPresent: false, error: null };
}

function loadFinalizedReceiptJournal() {
  const serialized = window.localStorage.getItem(FINALIZED_RECEIPTS_KEY);
  if (!serialized) return { receipt: null, error: null };
  try {
    const receipts = parseFinalizedTransferReceipts(serialized);
    return { receipt: receipts.length > 0 ? receipts[receipts.length - 1] : null, error: null };
  } catch {
    return {
      receipt: null,
      error: "The finalized receipt journal failed validation and remains quarantined. New transfers are blocked.",
    };
  }
}

async function validatePendingWire(pending: PendingBroadcast) {
  if (
    ![
      pending.blockhashContextSlot,
      pending.contractReadSlot,
      pending.lastValidBlockHeight,
      pending.feeLamports,
      pending.ataRentLamports,
      pending.simulatedPayerDebitLamports,
      pending.streamLamportsBefore,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new Error("Pending transfer has invalid block-height or cost metadata.");
  }
  if (
    pending.simulatedPayerDebitLamports !== pending.feeLamports + pending.ataRentLamports ||
    pending.simulatedPayerDebitLamports > MAX_TOTAL_COST_LAMPORTS
  ) {
    throw new Error("Pending transfer cost metadata violates the reviewed safety cap.");
  }
  if (!Number.isFinite(Date.parse(pending.savedAt))) throw new Error("Pending transfer timestamp is invalid.");
  if (![
    pending.semanticDigest,
    pending.signedMessageSha256,
    pending.signedWireSha256,
    pending.programDataSha256,
    pending.streamRawBeforeSha256,
    pending.simulatedStreamRawAfterSha256,
  ].every((value) => /^[0-9a-f]{64}$/.test(value))) {
    throw new Error("Pending transfer digest metadata is invalid.");
  }
  if (pending.programDataSha256 !== EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256) {
    throw new Error("Pending transfer was not reviewed against the pinned Streamflow program data.");
  }
  if (
    pending.simulatedRawChangedBytes.length === 0 ||
    pending.simulatedRawChangedBytes.some(
      (index, position) =>
        !Number.isInteger(index) ||
        index < RAW_RECIPIENT_START ||
        index > RAW_RECIPIENT_END ||
        (position > 0 && index <= pending.simulatedRawChangedBytes[position - 1]),
    )
  ) {
    throw new Error("Pending transfer has invalid raw-state transition metadata.");
  }

  const contract = new PublicKey(pending.contractId);
  const source = new PublicKey(pending.source);
  const destination = new PublicKey(pending.destination);
  const destinationAta = new PublicKey(pending.destinationAta);
  const mint = new PublicKey(pending.mint);
  const tokenProgram = new PublicKey(pending.tokenProgram);
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Pending transfer uses an unsupported token program.");
  }
  if (destination.equals(source)) throw new Error("Pending destination equals the source wallet.");
  if (pending.streamBefore.mint !== pending.mint || pending.streamBefore.recipient !== pending.source) {
    throw new Error("Pending pre-state does not match the reviewed mint and source recipient.");
  }
  if (pending.streamBefore.transferableByRecipient !== true) {
    throw new Error("Pending contract is not recipient-transferable.");
  }
  for (const field of REQUIRED_STREAM_FIELDS) {
    if (!(field in pending.streamBefore)) throw new Error(`Pending pre-state is missing ${field}.`);
  }
  const streamRawBefore = decodeCanonicalBase64(pending.streamRawBeforeBase64, "Pending Streamflow baseline");
  if (streamRawBefore.length !== STREAMFLOW_V4_ACCOUNT_BYTES) {
    throw new Error(`Pending Streamflow baseline must be ${STREAMFLOW_V4_ACCOUNT_BYTES} bytes.`);
  }
  if ((await sha256Hex(streamRawBefore)) !== pending.streamRawBeforeSha256) {
    throw new Error("Pending Streamflow baseline does not match its retained digest.");
  }
  if (JSON.stringify(snapshotStream(decodeOnchainStream(streamRawBefore))) !== JSON.stringify(pending.streamBefore)) {
    throw new Error("Pending decoded Streamflow pre-state does not match its raw baseline.");
  }

  const wireBuffer = decodeCanonicalBase64(pending.wireBase64, "Pending signed transaction");
  const wire = new Uint8Array(wireBuffer);
  if ((await sha256Hex(wire)) !== pending.signedWireSha256) {
    throw new Error("Pending signed transaction bytes do not match their retained digest.");
  }
  const transaction = VersionedTransaction.deserialize(wire);
  if (!(transaction.message instanceof MessageV0)) throw new Error("Pending transaction is not version 0.");
  if (transaction.message.recentBlockhash !== pending.blockhash) {
    throw new Error("Pending transaction blockhash does not match its retained metadata.");
  }
  if ((await sha256Hex(transaction.message.serialize())) !== pending.signedMessageSha256) {
    throw new Error("Pending transaction message does not match its retained digest.");
  }
  if (transaction.signatures.length !== 1) throw new Error("Pending transaction has an unexpected signature count.");
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  if (expectedSignature !== pending.expectedSignature) throw new Error("Pending transaction txid does not match its signature.");
  if (!nacl.sign.detached.verify(
    transaction.message.serialize(),
    transaction.signatures[0],
    source.toBytes(),
  )) {
    throw new Error("Pending transaction signature does not verify for the source wallet.");
  }
  const validation = await validateCompiledTransferMessage({
    message: transaction.message,
    streamflowProgramId: STREAMFLOW_PROGRAM_ID,
    authority: source,
    destination,
    contract,
    mint,
  });
  if (!validation.destinationAta.equals(destinationAta)) {
    throw new Error("Pending destination token account does not match the signed transaction.");
  }
  if (validation.semanticDigest !== pending.semanticDigest) {
    throw new Error("Pending semantic digest does not match the signed transaction.");
  }
  if (!validation.tokenProgram.equals(tokenProgram)) {
    throw new Error("Pending token program does not match the signed transaction.");
  }
  return { transaction, wire, contract, source, destination, destinationAta, mint, tokenProgram };
}

async function assertArmedPendingUnchanged(pending: PendingBroadcast) {
  const expected = JSON.stringify(pending);
  assertArmedTransferUnchanged(window.localStorage, expected);
  const serialized = window.localStorage.getItem(PENDING_BROADCAST_KEY) ?? "";
  const current = parsePendingBroadcast(serialized);
  await validatePendingWire(current);
  if (
    JSON.stringify(current) !== expected ||
    window.localStorage.getItem(PENDING_BROADCAST_KEY) !== expected
  ) {
    throw new Error("The armed pending record changed during validation.");
  }
}

function buildDestinationChallenge({
  contractId,
  source,
  destination,
  amount,
  semanticDigest,
}: {
  contractId: string;
  source: string;
  destination: string;
  amount: string;
  semanticDigest: string;
}) {
  return [
    "Streamflow recipient transfer destination proof",
    "Network: Solana mainnet-beta",
    `Current recipient: ${source}`,
    `Contract: ${contractId}`,
    `New recipient: ${destination}`,
    `Complete position: ${amount} tokens`,
    `Reviewed transaction: ${semanticDigest}`,
  ].join("\n");
}

async function readStreamflowProgramHash(connection: Connection, commitment: Commitment) {
  const program = await connection.getAccountInfo(STREAMFLOW_PROGRAM_ID, commitment);
  if (!program?.executable || !program.owner.equals(UPGRADEABLE_LOADER_ID)) {
    throw new Error("The expected Streamflow program is not executable under Solana's upgradeable loader.");
  }
  if (program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) {
    throw new Error("Unexpected Streamflow upgradeable program account layout.");
  }
  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(programDataAddress, commitment);
  if (!programData?.owner.equals(UPGRADEABLE_LOADER_ID)) {
    throw new Error("Streamflow program data account owner mismatch.");
  }
  const programDataSha256 = await sha256Hex(programData.data);
  if (programDataSha256 !== EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256) {
    throw new Error(`Streamflow program data hash changed unexpectedly: ${programDataSha256}.`);
  }
  return programDataSha256;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    if (/rejected|declined/i.test(error.message)) return "The wallet request was rejected.";
    return error.message;
  }
  return "The operation failed for an unknown reason.";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button className="icon-button" type="button" onClick={copy} title={`Copy ${label}`} aria-label={`Copy ${label}`}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function PositionTransferApp() {
  const { connection } = useConnection();
  const { publicKey, connected, signMessage, signTransaction, wallet } = useWallet();
  const client = useMemo(
    () =>
      new SolanaStreamClient({
        connection,
        cluster: ICluster.Mainnet,
        commitment: "confirmed",
        programId: STREAMFLOW_PROGRAM_ID.toBase58(),
      }),
    [connection],
  );
  const initialPending = useMemo(() => loadPendingBroadcast(), []);
  const initialReceiptJournal = useMemo(() => loadFinalizedReceiptJournal(), []);
  const [contractId, setContractId] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationConfirmation, setDestinationConfirmation] = useState("");
  const [destinationProof, setDestinationProof] = useState<DestinationProof | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"simulate" | "sign" | "broadcast" | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [signedTransfer, setSignedTransfer] = useState<SignedTransfer | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<PendingBroadcast | null>(initialPending.pending);
  const [preparedTransferPresent, setPreparedTransferPresent] = useState(initialPending.preparedPresent);
  const [pendingRecordError, setPendingRecordError] = useState<string | null>(
    initialPending.error,
  );
  const [receiptRecordError, setReceiptRecordError] = useState<string | null>(initialReceiptJournal.error);
  const [receipt, setReceipt] = useState<Receipt | null>(initialReceiptJournal.receipt);
  const [receiptVerification, setReceiptVerification] = useState<
    "none" | "verifying" | "verified" | "invalid"
  >(initialReceiptJournal.receipt ? "verifying" : "none");
  const [receiptRetryNonce, setReceiptRetryNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const operationLock = useRef(false);
  const operationGeneration = useRef(0);
  const connectedAddressRef = useRef<string | null>(null);
  const walletAdapterNameRef = useRef<string | null>(null);
  const recoverySubmissionRef = useRef<{ signature: string; attemptedAt: number } | null>(null);

  const connectedAddress = publicKey?.toBase58() ?? null;
  const walletAdapterName = wallet?.adapter.name ?? null;
  const sourceWalletMatches = preflight ? connectedAddress === preflight.source : connected;
  const actionsBlocked =
    busy !== null ||
    pendingTransfer !== null ||
    preparedTransferPresent ||
    pendingRecordError !== null ||
    receiptRecordError !== null ||
    receiptVerification === "verifying";

  useEffect(() => {
    connectedAddressRef.current = connectedAddress;
    walletAdapterNameRef.current = walletAdapterName;
    operationGeneration.current += 1;
    setAcknowledged(false);
    setSignedTransfer(null);
  }, [connectedAddress, walletAdapterName]);

  useEffect(() => {
    if (!receipt) {
      setReceiptVerification("none");
      return;
    }
    let cancelled = false;
    setReceiptVerification("verifying");
    setReceiptRecordError(null);
    void verifyFinalizedTransferReceipt(connection, receipt)
      .then(() => {
        if (!cancelled) setReceiptVerification("verified");
      })
      .catch((cause) => {
        if (cancelled) return;
        setReceiptVerification("invalid");
        setReceiptRecordError(
          `The finalized receipt could not be authenticated on-chain and remains quarantined: ${normalizeError(cause)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [connection, receipt, receiptRetryNonce]);

  const resetPreparedState = useCallback(() => {
    setPreflight(null);
    setSignedTransfer(null);
    setReceipt(null);
    setAcknowledged(false);
    setDestinationProof(null);
    setError(null);
  }, []);

  const verifyAndBuild = useCallback(async (): Promise<Preflight> => {
    if (!publicKey || !connected) throw new Error("Connect the current recipient wallet before continuing.");
    if (!wallet?.adapter.name) throw new Error("The connected wallet adapter is unavailable.");
    const generationAtStart = operationGeneration.current;
    const source = publicKey.toBase58();

    const trimmedContract = contractId.trim();
    let contractKey: PublicKey;
    try {
      contractKey = new PublicKey(trimmedContract);
    } catch {
      throw new Error("Enter a valid Streamflow contract address.");
    }

    const trimmedDestination = destination.trim();
    let destinationKey: PublicKey;
    try {
      destinationKey = new PublicKey(trimmedDestination);
    } catch {
      throw new Error("Enter a valid Solana destination address.");
    }
    if (destinationKey.equals(publicKey)) throw new Error("Destination must differ from the current recipient.");
    const [
      genesisHash,
      programDataSha256,
      contractRead,
      destinationRead,
      latest,
      currentSlot,
    ] = await Promise.all([
      connection.getGenesisHash(),
      readStreamflowProgramHash(connection, "confirmed"),
      connection.getAccountInfoAndContext(contractKey, "confirmed"),
      connection.getAccountInfoAndContext(destinationKey, "confirmed"),
      connection.getLatestBlockhashAndContext("confirmed"),
      connection.getSlot("confirmed"),
    ]);
    if (genesisHash !== EXPECTED_MAINNET_GENESIS_HASH) {
      throw new Error(`RPC is not Solana mainnet-beta: ${genesisHash}`);
    }
    const streamflowProgramId = new PublicKey(client.getProgramId());
    if (!streamflowProgramId.equals(STREAMFLOW_PROGRAM_ID)) {
      throw new Error(`SDK selected an unexpected Streamflow program: ${streamflowProgramId.toBase58()}`);
    }
    const contractAccount = contractRead.value;
    if (!contractAccount) throw new Error("The Streamflow contract account does not exist on-chain.");
    if (!contractAccount.owner.equals(streamflowProgramId)) {
      throw new Error(`Contract owner is not the expected Streamflow program: ${contractAccount.owner.toBase58()}`);
    }
    if (contractAccount.data.length !== STREAMFLOW_V4_ACCOUNT_BYTES) {
      throw new Error(`Streamflow contract data is not the expected ${STREAMFLOW_V4_ACCOUNT_BYTES}-byte layout.`);
    }
    const streamRawBefore = Buffer.from(contractAccount.data);
    const streamRawBeforeBase64 = streamRawBefore.toString("base64");
    const streamRawBeforeSha256 = await sha256Hex(streamRawBefore);
    const initialContextSlots = [contractRead.context.slot, destinationRead.context.slot, latest.context.slot];
    if (
      Math.max(currentSlot, ...initialContextSlots) - Math.min(currentSlot, ...initialContextSlots) >
      MAX_CONTEXT_SLOT_DRIFT
    ) {
      throw new Error("RPC account reads are too stale relative to the current slot.");
    }
    const initialMinimumContextSlot = Math.max(currentSlot, ...initialContextSlots);
    const stream = decodeOnchainStream(contractAccount.data);
    const streamBefore = snapshotStream(stream);
    if (stream.closed) throw new Error("The selected Streamflow contract is closed.");
    if (stream.recipient !== source) throw new Error("The connected wallet is not the contract's current recipient.");
    if (!stream.transferableByRecipient) throw new Error("This contract is not transferable by its recipient.");
    const destinationCheck = validateDestinationWallet(destinationKey, destinationRead.value);

    if (BigInt(stream.depositedAmount.toString()) <= BigInt(stream.withdrawnAmount.toString())) {
      throw new Error("This contract has no remaining position to transfer.");
    }

    const instructions = await client.prepareTransferInstructions(
      { id: contractKey.toBase58(), newRecipient: destinationKey.toBase58() },
      { invoker: { publicKey } },
    );
    const validation = await validateTransferInstructions({
      instructions,
      streamflowProgramId,
      authority: publicKey,
      destination: destinationKey,
      contract: contractKey,
      mint: new PublicKey(stream.mint),
    });
    const mintKey = new PublicKey(stream.mint);
    const mintRead = await connection.getAccountInfoAndContext(mintKey, {
      commitment: "confirmed",
      minContextSlot: initialMinimumContextSlot,
    });
    const mintAccount = mintRead.value;
    if (!mintAccount?.owner.equals(validation.tokenProgram)) {
      throw new Error("Mint owner does not match the token program in the transfer instruction.");
    }
    const contextSlots = [...initialContextSlots, mintRead.context.slot];
    if (
      Math.max(currentSlot, ...contextSlots) - Math.min(currentSlot, ...contextSlots) >
      MAX_CONTEXT_SLOT_DRIFT
    ) {
      throw new Error("RPC mint and contract reads are too far apart for a consistent review.");
    }
    const minimumContextSlot = Math.max(currentSlot, ...contextSlots);
    const mintState = unpackMint(mintKey, mintAccount, validation.tokenProgram);
    const remaining = formatRemaining(stream, mintState.decimals);
    const destinationTokenAccountBytes = getDestinationAtaSize(mintState.tlvData, validation.tokenProgram);

    const message = new TransactionMessage({
      payerKey: publicKey,
      recentBlockhash: latest.value.blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const [simulation, fee, destinationAtaRead, payerBalanceRead] = await Promise.all([
      connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        minContextSlot: minimumContextSlot,
        accounts: {
          encoding: "base64",
          addresses: [publicKey.toBase58(), contractKey.toBase58()],
        },
      }),
      connection.getFeeForMessage(message, "confirmed"),
      connection.getAccountInfoAndContext(validation.destinationAta, {
        commitment: "confirmed",
        minContextSlot: minimumContextSlot,
      }),
      connection.getBalanceAndContext(publicKey, {
        commitment: "confirmed",
        minContextSlot: minimumContextSlot,
      }),
    ]);
    if (simulation.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    if (simulation.value.unitsConsumed === undefined) throw new Error("RPC did not return compute usage.");
    if (simulation.value.unitsConsumed > 100_001) throw new Error("Simulation exceeded the reviewed compute limit.");
    if (fee.value === null) throw new Error("RPC could not estimate the transaction fee.");
    const simulatedPayer = simulation.value.accounts?.[0];
    const simulatedContract = simulation.value.accounts?.[1];
    if (!simulatedPayer || !simulatedContract || simulation.value.accounts?.length !== 2) {
      throw new Error("RPC did not return both simulated payer and Streamflow contract post-state.");
    }
    if (
      simulatedContract.executable ||
      simulatedContract.owner !== STREAMFLOW_PROGRAM_ID.toBase58() ||
      simulatedContract.lamports !== contractAccount.lamports
    ) {
      throw new Error("Simulation changed the Streamflow contract owner, executable flag, or lamports.");
    }
    const simulatedStreamRawAfter = decodeSimulatedAccountData(
      simulatedContract.data,
      "Simulated Streamflow contract",
    );
    const simulatedRawChangedBytes = assertRawRecipientOnlyTransition(streamRawBefore, simulatedStreamRawAfter);
    const simulatedStreamAfter = snapshotStream(decodeOnchainStream(simulatedStreamRawAfter));
    assertRecipientOnlyTransition(
      streamBefore,
      simulatedStreamAfter,
      destinationKey.toBase58(),
      validation.destinationAta.toBase58(),
    );
    const simulatedStreamRawAfterSha256 = await sha256Hex(simulatedStreamRawAfter);
    const costReadSlots = [
      simulation.context.slot,
      fee.context.slot,
      destinationAtaRead.context.slot,
      payerBalanceRead.context.slot,
    ];
    if (Math.max(...costReadSlots) - Math.min(...costReadSlots) > MAX_CONTEXT_SLOT_DRIFT) {
      throw new Error("RPC cost reads are too far apart to enforce the payer debit safely.");
    }
    if (destinationAtaRead.value) {
      const destinationTokenAccount = unpackAccount(
        validation.destinationAta,
        destinationAtaRead.value,
        validation.tokenProgram,
      );
      if (!destinationTokenAccount.mint.equals(new PublicKey(stream.mint)) || !destinationTokenAccount.owner.equals(destinationKey)) {
        throw new Error("Existing destination ATA does not match the reviewed mint and wallet owner.");
      }
      assertDestinationTokenAccountUsable(destinationTokenAccount);
    } else {
      assertNewDestinationTokenAccountUsable(mintState, validation.tokenProgram);
    }
    const ataRentLamports = destinationAtaRead.value
      ? 0
      : await connection.getMinimumBalanceForRentExemption(destinationTokenAccountBytes, "confirmed");
    const simulatedPayerDebitLamports = enforceSimulatedPayerDebit({
      preLamports: payerBalanceRead.value,
      postLamports: simulatedPayer.lamports,
      feeLamports: fee.value,
      expectedProgramDebitLamports: ataRentLamports,
      maximumLamports: MAX_TOTAL_COST_LAMPORTS,
    });
    const estimatedTotalLamports = simulatedPayerDebitLamports;
    if (payerBalanceRead.value < estimatedTotalLamports) {
      throw new Error(
        `Signer needs approximately ${(estimatedTotalLamports / 1_000_000_000).toFixed(6)} SOL for fees and recipient token-account rent.`,
      );
    }
    const semanticDigest = await semanticTransactionDigest(publicKey, instructions);
    const messageSha256 = await sha256Hex(message.serialize());
    const destinationChallenge = buildDestinationChallenge({
      contractId: contractKey.toBase58(),
      source,
      destination: destinationKey.toBase58(),
      amount: remaining,
      semanticDigest,
    });
    if (
      operationGeneration.current !== generationAtStart ||
      connectedAddressRef.current !== source
    ) {
      throw new Error("Wallet changed during verification. Simulate again.");
    }

    return {
      contractId: contractKey.toBase58(),
      source,
      destination: destinationKey.toBase58(),
      mint: stream.mint,
      amount: remaining,
      streamType: String(stream.type),
      recipientTransferable: stream.transferableByRecipient,
      senderTransferable: stream.transferableBySender,
      tokenProgram: validation.tokenProgram.toBase58(),
      checkedAt: new Date().toISOString(),
      instructionPrograms: validation.instructionPrograms,
      unitsConsumed: simulation.value.unitsConsumed,
      feeLamports: fee.value,
      ataRentLamports,
      simulatedPayerDebitLamports,
      estimatedTotalLamports,
      semanticDigest,
      messageSha256,
      contractReadSlot: contractRead.context.slot,
      blockhashContextSlot: minimumContextSlot,
      destinationClassification: destinationCheck.classification,
      destinationBalanceLamports: destinationCheck.balanceLamports,
      destinationChallenge,
      programDataSha256,
      destinationAta: validation.destinationAta.toBase58(),
      streamBefore,
      streamLamportsBefore: contractAccount.lamports,
      streamRawBeforeBase64,
      streamRawBeforeSha256,
      simulatedStreamRawAfterSha256,
      simulatedRawChangedBytes,
      transaction,
      blockhash: latest.value.blockhash,
      lastValidBlockHeight: latest.value.lastValidBlockHeight,
    };
  }, [client, connected, connection, contractId, destination, publicKey, wallet?.adapter.name]);

  useEffect(() => {
    const serialized = window.localStorage.getItem(PENDING_BROADCAST_KEY);
    if (!serialized) return;
    try {
      const retained = parsePendingBroadcast(serialized);
      if (!pendingTransfer || retained.expectedSignature !== pendingTransfer.expectedSignature) {
        setPendingTransfer(retained);
      }
    } catch (cause) {
      setPendingTransfer(null);
      setPendingRecordError(
        `A pending transfer record failed validation and remains quarantined: ${normalizeError(cause)}`,
      );
    }
  }, [pendingTransfer]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key === PENDING_BROADCAST_KEY) {
        if (!event.newValue) {
          setPendingTransfer(null);
          setPreparedTransferPresent(Boolean(window.localStorage.getItem(PENDING_PREPARED_KEY)));
          return;
        }
        try {
          setPendingTransfer(parsePendingBroadcast(event.newValue));
          setPreparedTransferPresent(false);
        } catch (cause) {
          setPendingTransfer(null);
          setPendingRecordError(`Another tab wrote an invalid pending record: ${normalizeError(cause)}`);
        }
      }
      if (event.key === PENDING_PREPARED_KEY) {
        setPreparedTransferPresent(
          Boolean(event.newValue) && !window.localStorage.getItem(PENDING_BROADCAST_KEY),
        );
      }
      if (event.key === FINALIZED_RECEIPTS_KEY) {
        if (!event.newValue) {
          setReceipt(null);
          setReceiptRecordError(null);
          return;
        }
        try {
          const receipts = parseFinalizedTransferReceipts(event.newValue);
          setReceipt(receipts.length > 0 ? receipts[receipts.length - 1] : null);
          setReceiptRecordError(null);
        } catch (cause) {
          setReceipt(null);
          setReceiptRecordError(`The finalized receipt journal is invalid: ${normalizeError(cause)}`);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!pendingTransfer) return;
    let cancelled = false;

    const clearPending = () => {
      window.localStorage.removeItem(PENDING_BROADCAST_KEY);
      window.localStorage.removeItem(PENDING_PREPARED_KEY);
      recoverySubmissionRef.current = null;
      if (!cancelled) {
        setPendingTransfer(null);
        setPreparedTransferPresent(false);
      }
    };

    const reconcile = async () => {
      let retained: Awaited<ReturnType<typeof validatePendingWire>>;
      try {
        retained = await validatePendingWire(pendingTransfer);
      } catch (cause) {
        if (!cancelled) {
          setPendingRecordError(
            `The retained transaction failed validation and remains quarantined: ${normalizeError(cause)}`,
          );
          setError("New transfers remain blocked until the retained txid is reconciled.");
        }
        return;
      }

      while (!cancelled) {
        try {
          const status = await connection.getSignatureStatus(pendingTransfer.expectedSignature, {
            searchTransactionHistory: true,
          });
          if (status.value) recoverySubmissionRef.current = null;

          if (isFinalizedStatus(status.value)) {
            const finalized = await connection.getTransaction(pendingTransfer.expectedSignature, {
              commitment: "finalized",
              maxSupportedTransactionVersion: 0,
            });
            if (!finalized) throw new Error("Finalized transaction body is not available yet.");
            let actualPayerDebitLamports: number;
            try {
              if (!(finalized.transaction.message instanceof MessageV0)) {
                throw new Error("Finalized transaction is not version 0.");
              }
              if (
                finalized.transaction.signatures.length !== 1 ||
                finalized.transaction.signatures[0] !== pendingTransfer.expectedSignature
              ) {
                throw new Error("Finalized transaction signature differs from the retained txid.");
              }
              const finalizedMessageHash = await sha256Hex(finalized.transaction.message.serialize());
              if (finalizedMessageHash !== pendingTransfer.signedMessageSha256) {
                throw new Error("Finalized message differs from the exact signed message.");
              }
              const finalizedValidation = await validateCompiledTransferMessage({
                message: finalized.transaction.message,
                streamflowProgramId: STREAMFLOW_PROGRAM_ID,
                authority: retained.source,
                destination: retained.destination,
                contract: retained.contract,
                mint: retained.mint,
              });
              if (
                finalizedValidation.semanticDigest !== pendingTransfer.semanticDigest ||
                !finalizedValidation.destinationAta.equals(retained.destinationAta)
              ) {
                throw new Error("Finalized instruction semantics differ from the reviewed transfer.");
              }
              if (finalized.meta?.err) {
                await assertArmedPendingUnchanged(pendingTransfer);
                clearPending();
                if (!cancelled) setError(`Finalized transfer failed: ${JSON.stringify(finalized.meta.err)}`);
                return;
              }
              if (!finalized.meta) throw new Error("Finalized transaction metadata is unavailable.");
              if (finalized.meta.fee !== pendingTransfer.feeLamports) {
                throw new Error("Finalized transaction fee differs from the reviewed fee.");
              }
              const payerPreBalance = finalized.meta.preBalances[0];
              const payerPostBalance = finalized.meta.postBalances[0];
              actualPayerDebitLamports = enforceSimulatedPayerDebit({
                preLamports: payerPreBalance,
                postLamports: payerPostBalance,
                feeLamports: finalized.meta.fee,
                expectedProgramDebitLamports: pendingTransfer.ataRentLamports,
                maximumLamports: MAX_TOTAL_COST_LAMPORTS,
              });
              if (actualPayerDebitLamports !== pendingTransfer.simulatedPayerDebitLamports) {
                throw new Error("Finalized payer debit differs from the reviewed simulation.");
              }
            } catch (cause) {
              if (!cancelled) {
                setError(
                  `Transfer finalized but transaction semantics failed validation; new actions remain blocked: ${normalizeError(cause)}`,
                );
              }
              return;
            }

            const [programDataSha256, accountRead] = await Promise.all([
              readStreamflowProgramHash(connection, "finalized"),
              connection.getAccountInfoAndContext(retained.contract, {
                commitment: "finalized",
                minContextSlot: finalized.slot,
              }),
            ]);
            const account = accountRead.value;
            if (!account) throw new Error("Finalized contract account is not available yet.");
            let streamRawAfterSha256: string;
            let rawChangedBytes: number[];
            try {
              if (
                !account.owner.equals(STREAMFLOW_PROGRAM_ID) ||
                account.data.length !== STREAMFLOW_V4_ACCOUNT_BYTES ||
                account.lamports !== pendingTransfer.streamLamportsBefore
              ) {
                throw new Error("Finalized contract owner, data length, or lamports changed unexpectedly.");
              }
              const streamRawBefore = decodeCanonicalBase64(
                pendingTransfer.streamRawBeforeBase64,
                "Retained Streamflow baseline",
              );
              rawChangedBytes = assertRawRecipientOnlyTransition(streamRawBefore, account.data);
              streamRawAfterSha256 = await sha256Hex(account.data);
              if (
                !rawChangedBytesEqual(rawChangedBytes, pendingTransfer.simulatedRawChangedBytes) ||
                streamRawAfterSha256 !== pendingTransfer.simulatedStreamRawAfterSha256
              ) {
                throw new Error("Finalized raw Streamflow transition differs from the reviewed simulation.");
              }
              const postState = snapshotStream(decodeOnchainStream(account.data));
              assertRecipientOnlyTransition(
                pendingTransfer.streamBefore,
                postState,
                pendingTransfer.destination,
                pendingTransfer.destinationAta,
              );
            } catch (cause) {
              if (!cancelled) {
                setError(
                  `Transfer finalized but contract state failed validation; new actions remain blocked: ${normalizeError(cause)}`,
                );
              }
              return;
            }

            const finalizedBlockTime = finalized.blockTime ?? null;
            const durableReceipt: Receipt = {
              schema: "streamflow-position-transfer.receipt.v1",
              signature: pendingTransfer.expectedSignature,
              networkGenesisHash: EXPECTED_MAINNET_GENESIS_HASH,
              streamflowProgramId: STREAMFLOW_PROGRAM_ID.toBase58(),
              contractId: pendingTransfer.contractId,
              source: pendingTransfer.source,
              destination: pendingTransfer.destination,
              destinationAta: pendingTransfer.destinationAta,
              mint: pendingTransfer.mint,
              tokenProgram: pendingTransfer.tokenProgram,
              finalizedAt:
                finalizedBlockTime === null
                  ? new Date().toISOString()
                  : new Date(finalizedBlockTime * 1_000).toISOString(),
              slot: finalized.slot,
              blockTime: finalizedBlockTime,
              feeLamports: pendingTransfer.feeLamports,
              payerDebitLamports: actualPayerDebitLamports,
              semanticDigest: pendingTransfer.semanticDigest,
              signedMessageSha256: pendingTransfer.signedMessageSha256,
              programDataSha256,
              streamRawBeforeSha256: pendingTransfer.streamRawBeforeSha256,
              streamRawAfterSha256,
              rawChangedBytes,
            };
            await assertArmedPendingUnchanged(pendingTransfer);
            const serializedReceipts = appendFinalizedTransferReceipt(
              window.localStorage.getItem(FINALIZED_RECEIPTS_KEY),
              durableReceipt,
            );
            window.localStorage.setItem(FINALIZED_RECEIPTS_KEY, serializedReceipts);
            const persistedReceipt = parseFinalizedTransferReceipts(
              window.localStorage.getItem(FINALIZED_RECEIPTS_KEY) ?? "",
            ).find((candidate) => candidate.signature === durableReceipt.signature);
            if (!persistedReceipt || JSON.stringify(persistedReceipt) !== JSON.stringify(durableReceipt)) {
              throw new Error("Finalized receipt did not persist exactly; pending state remains blocking.");
            }
            clearPending();
            if (!cancelled) {
              setReceipt(persistedReceipt);
              setSignedTransfer(null);
              setAcknowledged(false);
              setError(null);
            }
            return;
          }

          const height = await connection.getBlockHeight("finalized");
          const priorRecoverySubmission = recoverySubmissionRef.current;
          const recoveryAction = decidePendingRecovery({
            hasStatus: Boolean(status.value),
            blockHeight: height,
            lastValidBlockHeight: pendingTransfer.lastValidBlockHeight,
            minimumBlockheightMargin: MIN_BLOCKHEIGHT_MARGIN,
            lastSubmissionAt:
              priorRecoverySubmission?.signature === pendingTransfer.expectedSignature
                ? priorRecoverySubmission.attemptedAt
                : null,
            now: Date.now(),
            rebroadcastIntervalMs: RECOVERY_REBROADCAST_INTERVAL_MS,
          });
          if (recoveryAction === "expire") {
            try {
              await requireFinalizedBaselineBeforeExpiryClear(recoveryAction, async () => {
                const expiryRead = await connection.getAccountInfoAndContext(retained.contract, {
                  commitment: "finalized",
                  minContextSlot: pendingTransfer.blockhashContextSlot,
                });
                const expiryAccount = expiryRead.value;
                if (
                  !expiryAccount?.owner.equals(STREAMFLOW_PROGRAM_ID) ||
                  expiryAccount.lamports !== pendingTransfer.streamLamportsBefore
                ) {
                  throw new Error("Finalized contract ownership or lamports no longer match the retained baseline.");
                }
                await assertRetainedRawBaseline({
                  current: expiryAccount.data,
                  retainedBase64: pendingTransfer.streamRawBeforeBase64,
                  retainedSha256: pendingTransfer.streamRawBeforeSha256,
                });
              });
            } catch (cause) {
              if (!cancelled) {
                setPendingRecordError(
                  `The signed transaction expired without indexed history, but finalized contract state changed. The record remains quarantined: ${normalizeError(cause)}`,
                );
              }
              return;
            }
            await assertArmedPendingUnchanged(pendingTransfer);
            clearPending();
            if (!cancelled) setError("The retained signed transfer expired without finalizing. Simulate again.");
            return;
          }

          if (recoveryAction === "wait_near_expiry") {
            if (!cancelled) {
              setError(
                `Retained transaction is too close to expiry to rebroadcast; waiting for txid ${pendingTransfer.expectedSignature}.`,
              );
            }
            await sleep(PENDING_POLL_INTERVAL_MS);
            continue;
          }

          if (recoveryAction === "rebroadcast") {
            const [programDataSha256, genesisHash, accountsRead, recoveredSimulation, payerBalanceRead] = await Promise.all([
              readStreamflowProgramHash(connection, "confirmed"),
              connection.getGenesisHash(),
              connection.getMultipleAccountsInfoAndContext(
                [retained.destination, retained.contract, retained.destinationAta, retained.mint],
                { commitment: "confirmed", minContextSlot: pendingTransfer.blockhashContextSlot },
              ),
              connection.simulateTransaction(retained.transaction, {
                sigVerify: true,
                replaceRecentBlockhash: false,
                commitment: "confirmed",
                minContextSlot: pendingTransfer.blockhashContextSlot,
                accounts: {
                  encoding: "base64",
                  addresses: [pendingTransfer.source, pendingTransfer.contractId],
                },
              }),
              connection.getBalanceAndContext(retained.source, {
                commitment: "confirmed",
                minContextSlot: pendingTransfer.blockhashContextSlot,
              }),
            ]);
            if (genesisHash !== EXPECTED_MAINNET_GENESIS_HASH) {
              throw new Error("RPC is not Solana mainnet-beta; the retained transaction was not rebroadcast.");
            }
            if (programDataSha256 !== pendingTransfer.programDataSha256) {
              throw new Error("Streamflow program changed; the retained transaction was not rebroadcast.");
            }
            if (accountsRead.context.slot < pendingTransfer.contractReadSlot) {
              throw new Error("Recovery readback is older than the reviewed Streamflow baseline.");
            }
            const [destinationRead, contractRead, destinationAtaRead, mintAccountRead] = accountsRead.value;
            validateDestinationWallet(retained.destination, destinationRead);
            if (!mintAccountRead?.owner.equals(retained.tokenProgram)) {
              throw new Error("Mint owner changed; the retained transaction was not rebroadcast.");
            }
            const recoveredMintState = unpackMint(retained.mint, mintAccountRead, retained.tokenProgram);
            if (
              !contractRead?.owner.equals(STREAMFLOW_PROGRAM_ID) ||
              contractRead.data.length !== STREAMFLOW_V4_ACCOUNT_BYTES ||
              contractRead.lamports !== pendingTransfer.streamLamportsBefore
            ) {
              throw new Error("Contract state is unavailable; the retained transaction was not rebroadcast.");
            }
            await assertRetainedRawBaseline({
              current: contractRead.data,
              retainedBase64: pendingTransfer.streamRawBeforeBase64,
              retainedSha256: pendingTransfer.streamRawBeforeSha256,
            });
            const currentState = snapshotStream(decodeOnchainStream(contractRead.data));
            if (JSON.stringify(currentState) !== JSON.stringify(pendingTransfer.streamBefore)) {
              throw new Error("Contract state changed; the retained transaction was not rebroadcast.");
            }
            const ataExistedDuringReview = pendingTransfer.ataRentLamports === 0;
            if (Boolean(destinationAtaRead) !== ataExistedDuringReview) {
              throw new Error("Destination ATA existence changed; the retained transaction was not rebroadcast.");
            }
            if (destinationAtaRead) {
              const destinationTokenAccount = unpackAccount(
                retained.destinationAta,
                destinationAtaRead,
                retained.tokenProgram,
              );
              if (
                !destinationTokenAccount.mint.equals(retained.mint) ||
                !destinationTokenAccount.owner.equals(retained.destination)
              ) {
                throw new Error("Destination ATA changed; the retained transaction was not rebroadcast.");
              }
              assertDestinationTokenAccountUsable(destinationTokenAccount);
            } else {
              assertNewDestinationTokenAccountUsable(recoveredMintState, retained.tokenProgram);
            }
            if (recoveredSimulation.value.err) {
              throw new Error(`Retained signed simulation failed: ${JSON.stringify(recoveredSimulation.value.err)}`);
            }
            const recoveredPayer = recoveredSimulation.value.accounts?.[0];
            const recoveredContract = recoveredSimulation.value.accounts?.[1];
            if (!recoveredPayer || !recoveredContract || recoveredSimulation.value.accounts?.length !== 2) {
              throw new Error("Retained signed simulation did not return payer and Streamflow post-state.");
            }
            if (
              recoveredContract.executable ||
              recoveredContract.owner !== STREAMFLOW_PROGRAM_ID.toBase58() ||
              recoveredContract.lamports !== pendingTransfer.streamLamportsBefore
            ) {
              throw new Error("Retained signed simulation changed Streamflow account ownership or lamports.");
            }
            const recoveredStreamRawAfter = decodeSimulatedAccountData(
              recoveredContract.data,
              "Recovered simulated Streamflow contract",
            );
            const recoveredRawChangedBytes = assertRawRecipientOnlyTransition(contractRead.data, recoveredStreamRawAfter);
            if (
              !rawChangedBytesEqual(recoveredRawChangedBytes, pendingTransfer.simulatedRawChangedBytes) ||
              (await sha256Hex(recoveredStreamRawAfter)) !== pendingTransfer.simulatedStreamRawAfterSha256
            ) {
              throw new Error("Retained signed simulation raw transition differs from the reviewed transition.");
            }
            assertRecipientOnlyTransition(
              pendingTransfer.streamBefore,
              snapshotStream(decodeOnchainStream(recoveredStreamRawAfter)),
              pendingTransfer.destination,
              pendingTransfer.destinationAta,
            );
            if (Math.abs(recoveredSimulation.context.slot - payerBalanceRead.context.slot) > MAX_CONTEXT_SLOT_DRIFT) {
              throw new Error("Retained signed simulation payer reads are too far apart.");
            }
            const recoveredDebit = enforceSimulatedPayerDebit({
              preLamports: payerBalanceRead.value,
              postLamports: recoveredPayer.lamports,
              feeLamports: pendingTransfer.feeLamports,
              expectedProgramDebitLamports: pendingTransfer.ataRentLamports,
              maximumLamports: MAX_TOTAL_COST_LAMPORTS,
            });
            if (recoveredDebit !== pendingTransfer.simulatedPayerDebitLamports) {
              throw new Error("Retained signed transaction debit changed; it was not rebroadcast.");
            }
            await assertArmedPendingUnchanged(pendingTransfer);
            recoverySubmissionRef.current = {
              signature: pendingTransfer.expectedSignature,
              attemptedAt: Date.now(),
            };
            let returnedSignature: string;
            try {
              returnedSignature = await connection.sendRawTransaction(retained.wire, {
                skipPreflight: true,
                maxRetries: 5,
                minContextSlot: pendingTransfer.blockhashContextSlot,
              });
            } catch (cause) {
              recoverySubmissionRef.current = null;
              throw cause;
            }
            if (returnedSignature !== pendingTransfer.expectedSignature) {
              throw new Error("RPC returned a signature different from the retained signed txid.");
            }
          }

          if (!cancelled) {
            setError(`Transfer ${pendingTransfer.expectedSignature} is pending finalization; new transfers are blocked.`);
          }
        } catch (cause) {
          if (!cancelled) {
            setError(`Pending transfer reconciliation will keep retrying: ${normalizeError(cause)}`);
          }
        }
        await sleep(PENDING_POLL_INTERVAL_MS);
      }
    };

    const reconcileWithOwnership = async () => {
      if (!navigator.locks) {
        if (!cancelled) {
          setError("This browser cannot safely reconcile the retained transfer without Web Locks.");
        }
        return;
      }
      await navigator.locks.request(BROADCAST_LOCK_KEY, { mode: "exclusive" }, async () => {
        if (cancelled) return;
        const serialized = window.localStorage.getItem(PENDING_BROADCAST_KEY);
        if (!serialized) {
          setPendingTransfer(null);
          setPreparedTransferPresent(Boolean(window.localStorage.getItem(PENDING_PREPARED_KEY)));
          return;
        }
        let current: PendingBroadcast;
        try {
          current = parsePendingBroadcast(serialized);
        } catch (cause) {
          setPendingRecordError(`The armed pending record is invalid and remains blocked: ${normalizeError(cause)}`);
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(pendingTransfer)) {
          setPendingTransfer(current);
          return;
        }
        await reconcile();
      });
    };

    void reconcileWithOwnership().catch((cause) => {
      if (!cancelled) setError(`Pending transfer reconciliation stopped safely: ${normalizeError(cause)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [connection, pendingTransfer]);

  const simulate = async () => {
    if (operationLock.current) return;
    if (pendingTransfer || hasRetainedPendingRecord()) {
      setError("A signed transfer is still being reconciled. New transfers are blocked until it finalizes or expires.");
      return;
    }
    operationLock.current = true;
    setBusy("simulate");
    setError(null);
    setReceipt(null);
    setSignedTransfer(null);
    setAcknowledged(false);
    setDestinationProof(null);
    try {
      setPreflight(await verifyAndBuild());
    } catch (cause) {
      setPreflight(null);
      setError(normalizeError(cause));
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  const proveDestination = async () => {
    if (operationLock.current || !preflight) return;
    if (!publicKey || publicKey.toBase58() !== preflight.destination) {
      setError(`Connect the destination wallet ${preflight.destination} to prove control.`);
      return;
    }
    if (!wallet?.adapter.name || !signMessage) {
      setError("The connected wallet does not expose message signing.");
      return;
    }
    operationLock.current = true;
    setBusy("sign");
    setError(null);
    try {
      const challenge = new TextEncoder().encode(preflight.destinationChallenge);
      const signature = await signMessage(challenge);
      if (!nacl.sign.detached.verify(challenge, signature, publicKey.toBytes())) {
        throw new Error("Destination proof signature did not verify.");
      }
      setDestinationProof({
        destination: preflight.destination,
        challengeSha256: await sha256Hex(challenge),
        signature: bs58.encode(signature),
      });
      setAcknowledged(false);
    } catch (cause) {
      setDestinationProof(null);
      setError(normalizeError(cause));
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  const sign = async () => {
    if (operationLock.current || !preflight || !acknowledged || !signTransaction) return;
    if (pendingTransfer || hasRetainedPendingRecord()) {
      setError("A previous signed transfer is still being reconciled.");
      return;
    }
    if (
      !publicKey ||
      connectedAddressRef.current !== preflight.source ||
      publicKey.toBase58() !== preflight.source ||
      !wallet?.adapter.name
    ) {
      setError(`Reconnect the reviewed recipient ${preflight.source} before signing.`);
      return;
    }
    if (destinationConfirmation.trim() !== preflight.destination) {
      setError("Re-enter the complete destination address exactly before signing.");
      return;
    }
    const reviewedChallenge = new TextEncoder().encode(preflight.destinationChallenge);
    if (
      !destinationProof ||
      destinationProof.destination !== preflight.destination ||
      destinationProof.challengeSha256 !== (await sha256Hex(reviewedChallenge)) ||
      !nacl.sign.detached.verify(
        reviewedChallenge,
        bs58.decode(destinationProof.signature),
        new PublicKey(preflight.destination).toBytes(),
      )
    ) {
      setError("A verified signed-message proof from the destination wallet is required.");
      return;
    }
    operationLock.current = true;
    const generationAtSignStart = operationGeneration.current;
    const walletAdapterNameAtStart = wallet.adapter.name;
    setBusy("sign");
    setError(null);
    setReceipt(null);
    setSignedTransfer(null);
    try {
      const fresh = await verifyAndBuild();
      if (
        fresh.contractId !== preflight.contractId ||
        fresh.destination !== preflight.destination ||
        fresh.amount !== preflight.amount ||
        fresh.semanticDigest !== preflight.semanticDigest ||
        fresh.destinationAta !== preflight.destinationAta ||
        fresh.feeLamports !== preflight.feeLamports ||
        fresh.simulatedPayerDebitLamports !== preflight.simulatedPayerDebitLamports ||
        fresh.estimatedTotalLamports !== preflight.estimatedTotalLamports ||
        fresh.programDataSha256 !== preflight.programDataSha256 ||
        fresh.destinationChallenge !== preflight.destinationChallenge ||
        fresh.streamLamportsBefore !== preflight.streamLamportsBefore ||
        fresh.streamRawBeforeBase64 !== preflight.streamRawBeforeBase64 ||
        fresh.streamRawBeforeSha256 !== preflight.streamRawBeforeSha256 ||
        fresh.simulatedStreamRawAfterSha256 !== preflight.simulatedStreamRawAfterSha256 ||
        !rawChangedBytesEqual(fresh.simulatedRawChangedBytes, preflight.simulatedRawChangedBytes) ||
        JSON.stringify(fresh.streamBefore) !== JSON.stringify(preflight.streamBefore)
      ) {
        throw new Error("A reviewed transfer field changed after simulation. Simulate and acknowledge again.");
      }
      setPreflight(fresh);

      const messageBefore = fresh.transaction.message.serialize();
      const signed = await signTransaction(fresh.transaction);
      if (
        operationGeneration.current !== generationAtSignStart ||
        connectedAddressRef.current !== fresh.source ||
        walletAdapterNameRef.current !== walletAdapterNameAtStart
      ) {
        throw new Error("Wallet or transfer inputs changed while the wallet was signing. Nothing was broadcast.");
      }
      if (!(signed instanceof VersionedTransaction)) throw new Error("The wallet returned an unexpected transaction type.");
      const messageAfter = signed.message.serialize();
      if (!bytesEqual(messageBefore, messageAfter)) {
        throw new Error("The wallet returned a transaction with a changed message. Nothing was broadcast.");
      }
      if (signed.message.header.numRequiredSignatures !== 1 || !signed.message.staticAccountKeys[0].equals(publicKey!)) {
        throw new Error("Signed transaction has an unexpected signer set.");
      }
      if (!nacl.sign.detached.verify(messageAfter, signed.signatures[0], publicKey!.toBytes())) {
        throw new Error("The wallet signature does not verify against the exact transaction message.");
      }

      const wireTransaction = signed.serialize();
      const roundTrip = VersionedTransaction.deserialize(wireTransaction);
      if (!bytesEqual(roundTrip.message.serialize(), messageAfter)) throw new Error("Serialized message changed.");
      if (!bytesEqual(roundTrip.signatures[0], signed.signatures[0])) throw new Error("Serialized signature changed.");
      const [signedSimulation, signedPayerBalanceRead] = await Promise.all([
        connection.simulateTransaction(roundTrip, {
          sigVerify: true,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          minContextSlot: fresh.blockhashContextSlot,
          accounts: {
            encoding: "base64",
            addresses: [publicKey.toBase58(), fresh.contractId],
          },
        }),
        connection.getBalanceAndContext(publicKey, {
          commitment: "confirmed",
          minContextSlot: fresh.blockhashContextSlot,
        }),
      ]);
      if (signedSimulation.value.err) {
        throw new Error(`Signed transaction simulation failed: ${JSON.stringify(signedSimulation.value.err)}`);
      }
      const signedSimulatedPayer = signedSimulation.value.accounts?.[0];
      const signedSimulatedContract = signedSimulation.value.accounts?.[1];
      if (!signedSimulatedPayer || !signedSimulatedContract || signedSimulation.value.accounts?.length !== 2) {
        throw new Error("Signed simulation did not return both payer and Streamflow contract post-state.");
      }
      if (
        signedSimulatedContract.executable ||
        signedSimulatedContract.owner !== STREAMFLOW_PROGRAM_ID.toBase58() ||
        signedSimulatedContract.lamports !== fresh.streamLamportsBefore
      ) {
        throw new Error("Signed simulation changed the Streamflow contract owner, executable flag, or lamports.");
      }
      const signedStreamRawAfter = decodeSimulatedAccountData(
        signedSimulatedContract.data,
        "Signed simulated Streamflow contract",
      );
      const signedRawChangedBytes = assertRawRecipientOnlyTransition(
        decodeCanonicalBase64(fresh.streamRawBeforeBase64, "Reviewed Streamflow baseline"),
        signedStreamRawAfter,
      );
      if (
        !rawChangedBytesEqual(signedRawChangedBytes, fresh.simulatedRawChangedBytes) ||
        (await sha256Hex(signedStreamRawAfter)) !== fresh.simulatedStreamRawAfterSha256
      ) {
        throw new Error("Signed simulation raw Streamflow transition changed after review. Nothing was broadcast.");
      }
      assertRecipientOnlyTransition(
        fresh.streamBefore,
        snapshotStream(decodeOnchainStream(signedStreamRawAfter)),
        fresh.destination,
        fresh.destinationAta,
      );
      if (Math.abs(signedSimulation.context.slot - signedPayerBalanceRead.context.slot) > MAX_CONTEXT_SLOT_DRIFT) {
        throw new Error("Signed simulation payer reads are too far apart.");
      }
      const signedPayerDebitLamports = enforceSimulatedPayerDebit({
        preLamports: signedPayerBalanceRead.value,
        postLamports: signedSimulatedPayer.lamports,
        feeLamports: fresh.feeLamports,
        expectedProgramDebitLamports: fresh.ataRentLamports,
        maximumLamports: MAX_TOTAL_COST_LAMPORTS,
      });
      if (signedPayerDebitLamports !== fresh.simulatedPayerDebitLamports) {
        throw new Error("Signed transaction payer debit changed after review. Nothing was broadcast.");
      }
      const expectedSignature = bs58.encode(signed.signatures[0]);
      const [signedMessageSha256, signedWireSha256] = await Promise.all([
        sha256Hex(messageAfter),
        sha256Hex(wireTransaction),
      ]);
      if (
        operationGeneration.current !== generationAtSignStart ||
        connectedAddressRef.current !== fresh.source ||
        walletAdapterNameRef.current !== walletAdapterNameAtStart
      ) {
        throw new Error("Wallet changed during signed verification. Nothing was broadcast.");
      }

      setSignedTransfer({
        ...fresh,
        signedAt: new Date().toISOString(),
        wireTransaction,
        expectedSignature,
        signedMessageSha256,
        signedWireSha256,
      });
      setAcknowledged(false);
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  const broadcastWithOwnership = async () => {
    if (operationLock.current || !signedTransfer || pendingTransfer) return;
    if (hasRetainedPendingRecord()) {
      setError("Another retained transaction exists. Nothing was submitted.");
      return;
    }
    if (
      connectedAddressRef.current !== signedTransfer.source ||
      publicKey?.toBase58() !== signedTransfer.source ||
      !wallet?.adapter.name ||
      walletAdapterNameRef.current !== wallet.adapter.name
    ) {
      setError(`Reconnect the reviewed recipient ${signedTransfer.source} before broadcasting.`);
      return;
    }
    operationLock.current = true;
    const generationAtBroadcastStart = operationGeneration.current;
    setBusy("broadcast");
    setError(null);
    setReceipt(null);
    let retainedPending: PendingBroadcast | null = null;
    let preparedWritten = false;
    let armedCommitted = false;
    try {
      const destinationKey = new PublicKey(signedTransfer.destination);
      const contractKey = new PublicKey(signedTransfer.contractId);
      const destinationAtaKey = new PublicKey(signedTransfer.destinationAta);
      const mintKey = new PublicKey(signedTransfer.mint);
      const tokenProgramKey = new PublicKey(signedTransfer.tokenProgram);
      const [currentBlockHeight, currentProgramDataSha256, genesisHash, accountsRead] = await Promise.all([
        connection.getBlockHeight("confirmed"),
        readStreamflowProgramHash(connection, "confirmed"),
        connection.getGenesisHash(),
        connection.getMultipleAccountsInfoAndContext(
          [destinationKey, contractKey, destinationAtaKey, mintKey],
          {
            commitment: "confirmed",
            minContextSlot: Math.max(signedTransfer.contractReadSlot, signedTransfer.blockhashContextSlot),
          },
        ),
      ]);
      if (currentBlockHeight + MIN_BLOCKHEIGHT_MARGIN >= signedTransfer.lastValidBlockHeight) {
        setSignedTransfer(null);
        throw new Error("The signed transaction is too close to expiry. Simulate and sign again.");
      }
      if (genesisHash !== EXPECTED_MAINNET_GENESIS_HASH) {
        setSignedTransfer(null);
        throw new Error("RPC network changed after signing. Simulate and review again.");
      }
      if (currentProgramDataSha256 !== signedTransfer.programDataSha256) {
        setSignedTransfer(null);
        throw new Error("Streamflow's on-chain program changed after signing. Simulate and review again.");
      }
      if (accountsRead.context.slot < signedTransfer.contractReadSlot) {
        throw new Error("Broadcast readback is older than the reviewed contract state.");
      }
      const [destinationAccount, contractAccount, destinationAtaAccount, mintAccount] = accountsRead.value;
      validateDestinationWallet(destinationKey, destinationAccount);
      if (!mintAccount?.owner.equals(tokenProgramKey)) {
        throw new Error("Mint owner changed after signing. Simulate and review again.");
      }
      const currentMintState = unpackMint(mintKey, mintAccount, tokenProgramKey);
      if (
        !contractAccount?.owner.equals(STREAMFLOW_PROGRAM_ID) ||
        contractAccount.data.length !== STREAMFLOW_V4_ACCOUNT_BYTES ||
        contractAccount.lamports !== signedTransfer.streamLamportsBefore
      ) {
        throw new Error("Contract state is unavailable immediately before broadcast.");
      }
      await assertRetainedRawBaseline({
        current: contractAccount.data,
        retainedBase64: signedTransfer.streamRawBeforeBase64,
        retainedSha256: signedTransfer.streamRawBeforeSha256,
      });
      const currentStreamState = snapshotStream(decodeOnchainStream(contractAccount.data));
      if (JSON.stringify(currentStreamState) !== JSON.stringify(signedTransfer.streamBefore)) {
        setSignedTransfer(null);
        throw new Error("Contract state changed after signing. Simulate and review again.");
      }
      const ataExistedDuringReview = signedTransfer.ataRentLamports === 0;
      if (Boolean(destinationAtaAccount) !== ataExistedDuringReview) {
        setSignedTransfer(null);
        throw new Error("Destination ATA existence changed after signing. Simulate and review again.");
      }
      if (destinationAtaAccount) {
        const destinationTokenAccount = unpackAccount(
          destinationAtaKey,
          destinationAtaAccount,
          tokenProgramKey,
        );
        if (
          !destinationTokenAccount.mint.equals(new PublicKey(signedTransfer.mint)) ||
          !destinationTokenAccount.owner.equals(destinationKey)
        ) {
          throw new Error("Destination ATA changed after signing. Simulate and review again.");
        }
        assertDestinationTokenAccountUsable(destinationTokenAccount);
      } else {
        assertNewDestinationTokenAccountUsable(currentMintState, tokenProgramKey);
      }
      const pending: PendingBroadcast = {
        schema: "streamflow-position-transfer.pending.v1",
        expectedSignature: signedTransfer.expectedSignature,
        contractId: signedTransfer.contractId,
        source: signedTransfer.source,
        destination: signedTransfer.destination,
        destinationAta: signedTransfer.destinationAta,
        mint: signedTransfer.mint,
        tokenProgram: signedTransfer.tokenProgram,
        blockhash: signedTransfer.blockhash,
        contractReadSlot: signedTransfer.contractReadSlot,
        blockhashContextSlot: signedTransfer.blockhashContextSlot,
        lastValidBlockHeight: signedTransfer.lastValidBlockHeight,
        feeLamports: signedTransfer.feeLamports,
        ataRentLamports: signedTransfer.ataRentLamports,
        simulatedPayerDebitLamports: signedTransfer.simulatedPayerDebitLamports,
        semanticDigest: signedTransfer.semanticDigest,
        signedMessageSha256: signedTransfer.signedMessageSha256,
        signedWireSha256: signedTransfer.signedWireSha256,
        wireBase64: Buffer.from(signedTransfer.wireTransaction).toString("base64"),
        programDataSha256: signedTransfer.programDataSha256,
        streamBefore: signedTransfer.streamBefore,
        streamLamportsBefore: signedTransfer.streamLamportsBefore,
        streamRawBeforeBase64: signedTransfer.streamRawBeforeBase64,
        streamRawBeforeSha256: signedTransfer.streamRawBeforeSha256,
        simulatedStreamRawAfterSha256: signedTransfer.simulatedStreamRawAfterSha256,
        simulatedRawChangedBytes: signedTransfer.simulatedRawChangedBytes,
        savedAt: new Date().toISOString(),
      };
      await validatePendingWire(pending);
      if (
        operationGeneration.current !== generationAtBroadcastStart ||
        connectedAddressRef.current !== signedTransfer.source ||
        walletAdapterNameRef.current !== wallet?.adapter.name
      ) {
        throw new Error("Wallet changed during broadcast verification. Nothing was submitted.");
      }
      const serializedPending = JSON.stringify(pending);
      retainedPending = await prepareAndArmTransfer({
        storage: window.localStorage,
        serialized: serializedPending,
        parse: parsePendingBroadcast,
        validate: async (persisted) => {
          await validatePendingWire(persisted);
        },
        assertStillCurrent: () => {
          if (
            operationGeneration.current !== generationAtBroadcastStart ||
            connectedAddressRef.current !== signedTransfer.source ||
            walletAdapterNameRef.current !== wallet?.adapter.name
          ) {
            throw new Error("Wallet changed before the prepared transfer was committed. Nothing was submitted.");
          }
        },
        onPrepared: () => {
          preparedWritten = true;
        },
      });
      armedCommitted = true;
      setPreparedTransferPresent(false);

      await assertArmedPendingUnchanged(retainedPending);
      recoverySubmissionRef.current = {
        signature: pending.expectedSignature,
        attemptedAt: Date.now(),
      };
      try {
        const returnedSignature = await connection.sendRawTransaction(signedTransfer.wireTransaction, {
          skipPreflight: true,
          maxRetries: 5,
          minContextSlot: signedTransfer.blockhashContextSlot,
        });
        if (returnedSignature !== signedTransfer.expectedSignature) {
          throw new Error("RPC returned a signature that differs from the locally derived txid.");
        }
      } catch (cause) {
        recoverySubmissionRef.current = null;
        const status = await connection.getSignatureStatus(signedTransfer.expectedSignature, {
          searchTransactionHistory: true,
        });
        if (!status.value) {
          throw new Error(
            `Initial submission was inconclusive; the exact retained transaction will be reconciled: ${normalizeError(cause)}`,
          );
        }
      }
      setError(`Submitted ${signedTransfer.expectedSignature}; waiting for independent finalized readback.`);
      setSignedTransfer(null);
      setAcknowledged(false);
    } catch (cause) {
      if (preparedWritten && !armedCommitted) {
        setPreparedTransferPresent(true);
        setError(
          `An unarmed signed draft remains quarantined and will not auto-submit: ${normalizeError(cause)}`,
        );
      } else {
        setError(normalizeError(cause));
      }
    } finally {
      if (retainedPending) setPendingTransfer(retainedPending);
      operationLock.current = false;
      setBusy(null);
    }
  };

  const broadcast = async () => {
    if (!navigator.locks) {
      setError("This browser cannot provide the required exclusive broadcast lock.");
      return;
    }
    await navigator.locks.request(
      BROADCAST_LOCK_KEY,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          setError("Another tab owns the Streamflow broadcast lock. Nothing was submitted.");
          return;
        }
        await broadcastWithOwnership();
      },
    );
  };

  const discardPreparedDraft = async () => {
    if (operationLock.current) return;
    if (!navigator.locks) {
      setError("This browser cannot safely discard the unarmed draft without Web Locks.");
      return;
    }
    operationLock.current = true;
    try {
      await navigator.locks.request(
        BROADCAST_LOCK_KEY,
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          if (!lock) {
            throw new Error("Another tab owns the transfer journal lock. The draft was not discarded.");
          }
          discardPreparedTransfer(window.localStorage);
          setPreparedTransferPresent(false);
          setError(null);
        },
      );
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      operationLock.current = false;
    }
  };

  const discardReceiptJournal = async () => {
    if (operationLock.current) return;
    if (!navigator.locks) {
      setError("This browser cannot safely discard the local receipt journal without Web Locks.");
      return;
    }
    operationLock.current = true;
    try {
      await navigator.locks.request(
        BROADCAST_LOCK_KEY,
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          if (!lock) {
            throw new Error("Another tab owns the transfer journal lock. The local receipt was not discarded.");
          }
          if (hasRetainedPendingRecord()) {
            throw new Error("A prepared or armed transfer still exists. Reconcile it before changing receipts.");
          }
          window.localStorage.removeItem(FINALIZED_RECEIPTS_KEY);
          if (window.localStorage.getItem(FINALIZED_RECEIPTS_KEY)) {
            throw new Error("The local receipt journal could not be removed.");
          }
          setReceipt(null);
          setReceiptVerification("none");
          setReceiptRecordError(null);
          setError(null);
        },
      );
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      operationLock.current = false;
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><LockKeyhole size={19} /></div>
          <div>
            <h1>Streamflow Position Transfer</h1>
            <span className="network-label">Solana mainnet-beta</span>
          </div>
        </div>
        <WalletMultiButton />
      </header>

      <main>
        <section className="summary-band" aria-label="Transfer profile">
          <div>
            <span className="metric-label">Network</span>
            <strong>Mainnet</strong>
          </div>
          <div>
            <span className="metric-label">Program</span>
            <strong className="positive">Pinned</strong>
          </div>
          <div>
            <span className="metric-label">Authority</span>
            <strong>Recipient</strong>
          </div>
          <div>
            <span className="metric-label">Debit cap</span>
            <strong>0.003 SOL</strong>
          </div>
        </section>

        <section className="transfer-section">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2>Set transfer</h2>
            </div>
            <span className="muted">Complete position recipient change</span>
          </div>

          <div className="wallet-readback">
            <WalletCards size={17} />
            <span>Connected wallet</span>
            <code title={connectedAddress ?? undefined}>
              {connectedAddress ? shorten(connectedAddress, 9) : "Not connected"}
            </code>
            {preflight && connected && (
              <span className={`wallet-match ${sourceWalletMatches ? "match" : "mismatch"}`}>
                {sourceWalletMatches ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                {sourceWalletMatches ? "Recipient matched" : "Switch wallet"}
              </span>
            )}
          </div>

          <div className="input-grid">
            <label>
              <span className="field-label">Streamflow contract</span>
              <input
                value={contractId}
                disabled={actionsBlocked}
                spellCheck={false}
                autoComplete="off"
                placeholder="Streamflow contract address"
                onChange={(event) => {
                  operationGeneration.current += 1;
                  setContractId(event.target.value);
                  setDestinationConfirmation("");
                  resetPreparedState();
                }}
              />
            </label>
            <label>
              <span className="field-label">New recipient</span>
              <input
                value={destination}
                disabled={actionsBlocked}
                spellCheck={false}
                autoComplete="off"
                placeholder="New recipient wallet address"
                onChange={(event) => {
                  operationGeneration.current += 1;
                  setDestination(event.target.value);
                  setDestinationConfirmation("");
                  resetPreparedState();
                }}
              />
            </label>
          </div>

          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!connected || !contractId.trim() || !destination.trim() || actionsBlocked}
              onClick={simulate}
            >
              {busy === "simulate" ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
              Inspect and simulate
            </button>
          </div>

          {pendingTransfer && (
            <div className="notice pending-notice">
              <LoaderCircle className="spin" size={17} />
              <span title={pendingTransfer.expectedSignature}>
                Reconciling signed txid <code>{shorten(pendingTransfer.expectedSignature, 10)}</code>. New transfers are blocked.
              </span>
            </div>
          )}
          {preparedTransferPresent && !pendingTransfer && (
            <div className="notice pending-notice">
              <CircleAlert size={17} />
              <span>An unarmed signed draft is quarantined. It will not be submitted automatically.</span>
              <button type="button" className="draft-discard-button" onClick={discardPreparedDraft}>
                <Trash2 size={14} />
                Discard unarmed draft
              </button>
            </div>
          )}
          {pendingRecordError && (
            <div className="notice error-notice"><CircleAlert size={17} /><span>{pendingRecordError}</span></div>
          )}
          {receiptRecordError && (
            <div className="notice error-notice receipt-error-notice">
              <CircleAlert size={17} />
              <span>{receiptRecordError}</span>
              <div className="notice-actions">
                {receipt && (
                  <button type="button" className="notice-action-button" onClick={() => setReceiptRetryNonce((value) => value + 1)}>
                    <RefreshCw size={14} />
                    Retry
                  </button>
                )}
                <button type="button" className="notice-action-button" onClick={discardReceiptJournal}>
                  <Trash2 size={14} />
                  Discard local record
                </button>
              </div>
            </div>
          )}
          {receipt && receiptVerification === "verifying" && (
            <div className="notice pending-notice">
              <LoaderCircle className="spin" size={17} />
              <span>Authenticating the retained finalized receipt against Solana mainnet.</span>
            </div>
          )}
          {error && <div className="notice error-notice"><CircleAlert size={17} /><span>{error}</span></div>}

          {preflight && (
            <div className="preflight-panel">
              <div className="preflight-title"><CheckCircle2 size={18} /><strong>Simulation passed</strong></div>
              <dl>
                <div><dt>Type</dt><dd>{preflight.streamType}</dd></div>
                <div><dt>Remaining</dt><dd>{preflight.amount} tokens</dd></div>
                <div><dt>Transfer flags</dt><dd>R:{String(preflight.recipientTransferable)} S:{String(preflight.senderTransferable)}</dd></div>
                <div><dt>Token program</dt><dd title={preflight.tokenProgram}><code>{shorten(preflight.tokenProgram, 7)}</code></dd></div>
                <div><dt>Compute units</dt><dd>{preflight.unitsConsumed.toLocaleString()}</dd></div>
                <div><dt>Debit</dt><dd>{(preflight.simulatedPayerDebitLamports / 1_000_000_000).toFixed(6)} SOL</dd></div>
                <div className="full-address-readback"><dt>Contract</dt><dd><code>{preflight.contractId}</code></dd></div>
                <div className="full-address-readback"><dt>Mint</dt><dd><code>{preflight.mint}</code></dd></div>
                <div className="full-address-readback"><dt>Current recipient</dt><dd><code>{preflight.source}</code></dd></div>
                <div className="full-address-readback"><dt>Destination</dt><dd><code>{preflight.destination}</code></dd></div>
                <div><dt>Destination type</dt><dd>{preflight.destinationClassification}</dd></div>
                <div><dt>Instructions</dt><dd>{preflight.instructionPrograms.length}</dd></div>
                <div><dt>Base fee</dt><dd>{preflight.feeLamports.toLocaleString()} lamports</dd></div>
                <div><dt>ATA rent</dt><dd>{preflight.ataRentLamports.toLocaleString()} lamports</dd></div>
                <div><dt>Raw state changes</dt><dd>bytes 113-176 only</dd></div>
                <div><dt>Semantic digest</dt><dd title={preflight.semanticDigest}><code>{shorten(preflight.semanticDigest, 8)}</code></dd></div>
              </dl>

              <label className="field-label" htmlFor="destination-confirmation">Re-enter the complete destination</label>
              <input
                className="confirmation-input"
                id="destination-confirmation"
                value={destinationConfirmation}
                disabled={actionsBlocked}
                spellCheck={false}
                autoComplete="off"
                placeholder="Type or paste the complete address again"
                onChange={(event) => {
                  setDestinationConfirmation(event.target.value);
                  setAcknowledged(false);
                }}
              />

              <div className={`destination-proof ${destinationProof ? "proof-complete" : ""}`}>
                <div>
                  {destinationProof ? <CheckCircle2 size={17} /> : <WalletCards size={17} />}
                  <span>
                    <strong>{destinationProof ? "Destination control proved" : "Destination signature required"}</strong>
                    <small>
                      {destinationProof
                        ? `Proof ${shorten(destinationProof.signature, 8)}`
                        : connectedAddress === preflight.destination
                          ? "The destination wallet is connected."
                          : `Connect ${shorten(preflight.destination, 9)} to this app.`}
                    </small>
                  </span>
                </div>
                <button
                  className="secondary-button proof-button"
                  type="button"
                  disabled={
                    destinationProof !== null ||
                    connectedAddress !== preflight.destination ||
                    !signMessage ||
                    actionsBlocked
                  }
                  onClick={proveDestination}
                >
                  {busy === "sign" && connectedAddress === preflight.destination ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ShieldCheck size={17} />
                  )}
                  {destinationProof ? "Verified" : "Prove control"}
                </button>
              </div>

              <label className="acknowledgement">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={
                    actionsBlocked ||
                    !destinationProof ||
                    destinationConfirmation.trim() !== preflight.destination
                  }
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>I verified the full address above. This irreversibly moves the complete position.</span>
              </label>

              <button
                className="primary-button"
                type="button"
                disabled={
                  !acknowledged ||
                  !destinationProof ||
                  destinationConfirmation.trim() !== preflight.destination ||
                  actionsBlocked ||
                  !sourceWalletMatches ||
                  !signTransaction
                }
                onClick={sign}
              >
                {busy === "sign" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
                {busy === "sign" ? "Waiting for wallet" : "Sign exact transaction"}
              </button>
            </div>
          )}

          {signedTransfer && (
            <div className="signed-panel">
              <div>
                <CheckCircle2 size={18} />
                <span>
                  <strong>Signature verified</strong>
                  <small title={signedTransfer.expectedSignature}>Exact v0 message and local txid verified.</small>
                </span>
              </div>
              <button
                className="broadcast-button"
                type="button"
                disabled={actionsBlocked || !sourceWalletMatches}
                onClick={broadcast}
              >
                {busy === "broadcast" ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
                {busy === "broadcast" ? "Confirming on-chain" : "Broadcast signed transfer"}
              </button>
            </div>
          )}

          {receipt && receiptVerification === "verified" && (
            <div className="receipt-panel">
              <CheckCircle2 size={20} />
              <div>
                <strong>Finalized transaction verified</strong>
                <span>
                  The on-chain message, signature, semantics, and costs match at slot {receipt.slot.toLocaleString()}.
                  Local-only contract readback metadata is retained separately and is not reauthenticated here.
                </span>
              </div>
              <a href={`https://solscan.io/tx/${receipt.signature}`} target="_blank" rel="noreferrer">
                View transaction <ExternalLink size={14} />
              </a>
            </div>
          )}
        </section>

        <footer>
          <span>Streamflow program</span>
          <code>{STREAMFLOW_PROGRAM_ID.toBase58()}</code>
          <CopyButton value={STREAMFLOW_PROGRAM_ID.toBase58()} label="Streamflow program address" />
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  return <PositionTransferApp />;
}
