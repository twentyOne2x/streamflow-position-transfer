import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";

const EXPECTED_COMPUTE_LIMIT_DATA = Uint8Array.from([2, 161, 134, 1, 0]);
const ZERO_PADDING = new Uint8Array(10);

export function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export async function sha256Bytes(value: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

export async function sha256Hex(value: Uint8Array) {
  return Array.from(await sha256Bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function transferDiscriminator() {
  return (await sha256Bytes(new TextEncoder().encode("global:transfer_recipient"))).slice(0, 8);
}

export async function semanticTransactionDigest(payer: PublicKey, instructions: TransactionInstruction[]) {
  const semanticShape = {
    payer: payer.toBase58(),
    instructions: instructions.map((instruction) => ({
      programId: instruction.programId.toBase58(),
      data: Array.from(instruction.data),
      keys: instruction.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
    })),
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(semanticShape)));
}

export function enforceSimulatedPayerDebit({
  preLamports,
  postLamports,
  feeLamports,
  expectedProgramDebitLamports,
  maximumLamports,
}: {
  preLamports: number;
  postLamports: number;
  feeLamports: number;
  expectedProgramDebitLamports: number;
  maximumLamports: number;
}) {
  const values = [preLamports, postLamports, feeLamports, expectedProgramDebitLamports, maximumLamports];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Payer debit inputs must be non-negative safe integers.");
  }
  const simulatedDebitLamports = preLamports - postLamports;
  const reviewedDebitLamports = feeLamports + expectedProgramDebitLamports;
  if (simulatedDebitLamports < 0) throw new Error("Simulation returned an impossible payer balance increase.");
  if (simulatedDebitLamports !== reviewedDebitLamports) {
    throw new Error(
      `Simulation would debit ${simulatedDebitLamports} lamports, but only ${reviewedDebitLamports} were reviewed.`,
    );
  }
  if (simulatedDebitLamports > maximumLamports) {
    throw new Error(`Simulated debit ${simulatedDebitLamports} exceeds the ${maximumLamports}-lamport safety cap.`);
  }
  return simulatedDebitLamports;
}

export function decidePendingRecovery({
  hasStatus,
  blockHeight,
  lastValidBlockHeight,
  minimumBlockheightMargin,
  lastSubmissionAt,
  now,
  rebroadcastIntervalMs,
}: {
  hasStatus: boolean;
  blockHeight: number;
  lastValidBlockHeight: number;
  minimumBlockheightMargin: number;
  lastSubmissionAt: number | null;
  now: number;
  rebroadcastIntervalMs: number;
}) {
  if (hasStatus) return "wait_for_finality" as const;
  if (blockHeight > lastValidBlockHeight) return "expire" as const;
  if (blockHeight + minimumBlockheightMargin >= lastValidBlockHeight) return "wait_near_expiry" as const;
  if (lastSubmissionAt !== null && now - lastSubmissionAt < rebroadcastIntervalMs) return "wait_for_backoff" as const;
  return "rebroadcast" as const;
}

export function validateDestinationWallet(destination: PublicKey, account: AccountInfo<Buffer> | null) {
  if (!PublicKey.isOnCurve(destination.toBytes())) {
    throw new Error("Destination is off-curve and may be a program-derived address.");
  }
  if (!account) {
    throw new Error("Destination wallet does not exist on-chain. Fund and verify it before transferring.");
  }
  if (account.executable) throw new Error("Destination is an executable program account.");
  if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Destination is a token account, not a wallet address.");
  }
  if (!account.owner.equals(SystemProgram.programId) || account.data.length !== 0) {
    throw new Error(`Destination is controlled by program ${account.owner.toBase58()}, not the System Program.`);
  }
  if (account.lamports <= 0) throw new Error("Destination wallet has no on-chain balance.");
  return {
    classification: "on-curve system wallet" as const,
    balanceLamports: account.lamports,
  };
}

export async function validateTransferInstructions({
  instructions,
  streamflowProgramId,
  authority,
  destination,
  contract,
  mint,
}: {
  instructions: TransactionInstruction[];
  streamflowProgramId: PublicKey;
  authority: PublicKey;
  destination: PublicKey;
  contract: PublicKey;
  mint: PublicKey;
}) {
  if (instructions.length !== 2) {
    throw new Error(`Expected exactly two transfer instructions, received ${instructions.length}.`);
  }
  const [computeInstruction, transferInstruction] = instructions;
  if (!computeInstruction.programId.equals(ComputeBudgetProgram.programId)) {
    throw new Error("First instruction is not the fixed compute-unit limit.");
  }
  if (computeInstruction.keys.length !== 0 || !bytesEqual(computeInstruction.data, EXPECTED_COMPUTE_LIMIT_DATA)) {
    throw new Error("Compute budget changed from the reviewed 100,001-unit limit.");
  }
  if (!transferInstruction.programId.equals(streamflowProgramId)) {
    throw new Error("Second instruction is not the expected Streamflow program.");
  }
  if (transferInstruction.keys.length !== 9) throw new Error("Unexpected Streamflow transfer account count.");

  const tokenProgram = transferInstruction.keys[6].pubkey;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`Unexpected token program: ${tokenProgram.toBase58()}`);
  }
  const expectedDestinationAta = getAssociatedTokenAddressSync(mint, destination, false, tokenProgram);
  const expectedAccounts = [
    authority,
    destination,
    expectedDestinationAta,
    contract,
    mint,
    SYSVAR_RENT_PUBKEY,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ];
  const expectedFlags = [
    [true, true],
    [false, true],
    [false, true],
    [false, true],
    [false, false],
    [false, false],
    [false, false],
    [false, false],
    [false, false],
  ];
  expectedAccounts.forEach((expected, index) => {
    const actual = transferInstruction.keys[index];
    if (!actual.pubkey.equals(expected)) throw new Error(`Unexpected transfer account at index ${index}.`);
    const [isSigner, isWritable] = expectedFlags[index];
    if (actual.isSigner !== isSigner || actual.isWritable !== isWritable) {
      throw new Error(`Unexpected signer or writable flags at transfer account ${index}.`);
    }
  });

  const expectedData = new Uint8Array(18);
  expectedData.set(await transferDiscriminator());
  expectedData.set(ZERO_PADDING, 8);
  if (!bytesEqual(transferInstruction.data, expectedData)) {
    throw new Error("Streamflow transfer data changed from the reviewed discriminator and zero padding.");
  }
  return {
    tokenProgram,
    destinationAta: expectedDestinationAta,
    instructionPrograms: instructions.map((instruction) => instruction.programId.toBase58()),
  };
}

export async function validateCompiledTransferMessage({
  message,
  streamflowProgramId,
  authority,
  destination,
  contract,
  mint,
}: {
  message: MessageV0;
  streamflowProgramId: PublicKey;
  authority: PublicKey;
  destination: PublicKey;
  contract: PublicKey;
  mint: PublicKey;
}) {
  if (!(message instanceof MessageV0)) throw new Error("Expected a version-0 transaction message.");
  if (message.addressTableLookups.length !== 0) {
    throw new Error("Address lookup tables are not allowed in the reviewed transfer.");
  }
  if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0]?.equals(authority)) {
    throw new Error("Compiled transaction has an unexpected fee payer or signer set.");
  }

  const instructions = decompileStaticInstructions(message);

  const validation = await validateTransferInstructions({
    instructions,
    streamflowProgramId,
    authority,
    destination,
    contract,
    mint,
  });
  return {
    ...validation,
    semanticDigest: await semanticTransactionDigest(authority, instructions),
  };
}

export function decompileStaticInstructions(message: MessageV0) {
  if (message.addressTableLookups.length !== 0) {
    throw new Error("Address lookup tables are not allowed in the reviewed transaction.");
  }
  return message.compiledInstructions.map((compiled, instructionIndex) => {
    const programId = message.staticAccountKeys[compiled.programIdIndex];
    if (!programId) throw new Error(`Instruction ${instructionIndex} has an invalid program index.`);
    const keys = compiled.accountKeyIndexes.map((accountIndex) => {
      const pubkey = message.staticAccountKeys[accountIndex];
      if (!pubkey) throw new Error(`Instruction ${instructionIndex} uses a non-static account.`);
      return {
        pubkey,
        isSigner: message.isAccountSigner(accountIndex),
        isWritable: message.isAccountWritable(accountIndex),
      };
    });
    return new TransactionInstruction({
      programId,
      keys,
      data: Buffer.from(compiled.data),
    });
  });
}
