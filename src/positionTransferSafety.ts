import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";

export const STREAMFLOW_V4_ACCOUNT_BYTES = 1_104;
export const RAW_RECIPIENT_START = 113;
export const RAW_RECIPIENT_END = 176;
export const STREAMFLOW_V4_PROGRAM_ID = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";
export const EXPECTED_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256 = "7a497b9370c252633f47d493b7e95271da05417c3fd7c212577417daaca1af56";
export const MAX_TOTAL_COST_LAMPORTS = 3_000_000;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type FinalizedTransferReceipt = {
  schema: "streamflow-position-transfer.receipt.v1";
  signature: string;
  networkGenesisHash: string;
  streamflowProgramId: string;
  contractId: string;
  source: string;
  destination: string;
  destinationAta: string;
  mint: string;
  tokenProgram: string;
  finalizedAt: string;
  slot: number;
  blockTime: number | null;
  feeLamports: number;
  payerDebitLamports: number;
  semanticDigest: string;
  signedMessageSha256: string;
  programDataSha256: string;
  streamRawBeforeSha256: string;
  streamRawAfterSha256: string;
  rawChangedBytes: number[];
};

export function decodeCanonicalBase64(value: string, label = "Encoded value") {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64.`);
  }
  return decoded;
}

export function assertRawRecipientOnlyTransition(before: Uint8Array, after: Uint8Array) {
  if (before.length !== STREAMFLOW_V4_ACCOUNT_BYTES || after.length !== STREAMFLOW_V4_ACCOUNT_BYTES) {
    throw new Error(`Streamflow account data must remain exactly ${STREAMFLOW_V4_ACCOUNT_BYTES} bytes.`);
  }

  const changed: number[] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    if (index < RAW_RECIPIENT_START || index > RAW_RECIPIENT_END) {
      throw new Error(`Streamflow raw state changed outside recipient fields at byte ${index}.`);
    }
    changed.push(index);
  }
  if (changed.length === 0) throw new Error("Streamflow raw recipient fields did not change.");
  return changed;
}

export function rawChangedBytesEqual(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSafeLamportValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isValidSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

function isValidChangedBytes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (index, position) =>
        Number.isInteger(index) &&
        index >= RAW_RECIPIENT_START &&
        index <= RAW_RECIPIENT_END &&
        (position === 0 || index > value[position - 1]),
    )
  );
}

function parseReceipt(value: unknown): FinalizedTransferReceipt {
  if (!value || typeof value !== "object") throw new Error("Finalized receipt must be an object.");
  const receipt = value as Partial<FinalizedTransferReceipt>;
  if (
    receipt.schema !== "streamflow-position-transfer.receipt.v1" ||
    !isValidSignature(receipt.signature) ||
    receipt.networkGenesisHash !== EXPECTED_MAINNET_GENESIS_HASH ||
    receipt.streamflowProgramId !== STREAMFLOW_V4_PROGRAM_ID ||
    !isValidPublicKey(receipt.contractId) ||
    !isValidPublicKey(receipt.source) ||
    !isValidPublicKey(receipt.destination) ||
    !isValidPublicKey(receipt.destinationAta) ||
    !isValidPublicKey(receipt.mint) ||
    !isValidPublicKey(receipt.tokenProgram) ||
    typeof receipt.finalizedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.finalizedAt)) ||
    !isSafeLamportValue(receipt.slot) ||
    !(receipt.blockTime === null || isSafeLamportValue(receipt.blockTime)) ||
    !isSafeLamportValue(receipt.feeLamports) ||
    !isSafeLamportValue(receipt.payerDebitLamports) ||
    !HASH_PATTERN.test(receipt.semanticDigest ?? "") ||
    !HASH_PATTERN.test(receipt.signedMessageSha256 ?? "") ||
    !HASH_PATTERN.test(receipt.programDataSha256 ?? "") ||
    !HASH_PATTERN.test(receipt.streamRawBeforeSha256 ?? "") ||
    !HASH_PATTERN.test(receipt.streamRawAfterSha256 ?? "") ||
    receipt.programDataSha256 !== EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256 ||
    receipt.payerDebitLamports! < receipt.feeLamports! ||
    receipt.payerDebitLamports! > MAX_TOTAL_COST_LAMPORTS ||
    !isValidChangedBytes(receipt.rawChangedBytes)
  ) {
    throw new Error("Finalized receipt failed schema validation.");
  }
  return receipt as FinalizedTransferReceipt;
}

export function parseFinalizedTransferReceipts(serialized: string) {
  const value = JSON.parse(serialized) as unknown;
  if (!Array.isArray(value)) throw new Error("Finalized receipt journal must be an array.");
  const receipts = value.map(parseReceipt);
  if (new Set(receipts.map((receipt) => receipt.signature)).size !== receipts.length) {
    throw new Error("Finalized receipt journal contains duplicate transaction signatures.");
  }
  return receipts;
}

export function appendFinalizedTransferReceipt(
  serialized: string | null,
  receipt: FinalizedTransferReceipt,
) {
  const validated = parseReceipt(receipt);
  const current = serialized ? parseFinalizedTransferReceipts(serialized) : [];
  const existing = current.find((candidate) => candidate.signature === validated.signature);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(validated)) {
      throw new Error("Finalized receipt signature already exists with different evidence.");
    }
    return JSON.stringify(current);
  }
  return JSON.stringify([...current, validated]);
}
