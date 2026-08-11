import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type AccountInfo,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  decidePendingRecovery,
  enforceSimulatedPayerDebit,
  semanticTransactionDigest,
  sha256Bytes,
  validateCompiledTransferMessage,
  validateDestinationWallet,
  validateTransferInstructions,
} from "./transactionSafety";

const STREAMFLOW_PROGRAM = new PublicKey("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m");

async function fixture() {
  const authority = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const contract = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const destinationAta = getAssociatedTokenAddressSync(mint, destination);
  const discriminator = (await sha256Bytes(new TextEncoder().encode("global:transfer_recipient"))).slice(0, 8);
  const data = new Uint8Array(18);
  data.set(discriminator);
  return {
    authority,
    destination,
    contract,
    mint,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_001 }),
      new TransactionInstruction({
        programId: STREAMFLOW_PROGRAM,
        data: Buffer.from(data),
        keys: [
          { pubkey: authority, isSigner: true, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: destinationAta, isSigner: false, isWritable: true },
          { pubkey: contract, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    ],
  };
}

async function validate(value: Awaited<ReturnType<typeof fixture>>) {
  return validateTransferInstructions({
    instructions: value.instructions,
    streamflowProgramId: STREAMFLOW_PROGRAM,
    authority: value.authority,
    destination: value.destination,
    contract: value.contract,
    mint: value.mint,
  });
}

describe("validateTransferInstructions", () => {
  it("accepts only the reviewed two-instruction transfer", async () => {
    const value = await fixture();
    const result = await validate(value);
    expect(result.instructionPrograms).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      STREAMFLOW_PROGRAM.toBase58(),
    ]);
  });

  it("rejects an injected or duplicated Streamflow instruction", async () => {
    const value = await fixture();
    value.instructions.splice(1, 0, value.instructions[1]);
    await expect(validate(value)).rejects.toThrow("exactly two");
  });

  it("rejects priority-fee injection", async () => {
    const value = await fixture();
    value.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }));
    await expect(validate(value)).rejects.toThrow("exactly two");
  });

  it("rejects a changed compute limit", async () => {
    const value = await fixture();
    value.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
    await expect(validate(value)).rejects.toThrow("100,001-unit limit");
  });

  it("rejects mutated signer and writable flags", async () => {
    const value = await fixture();
    value.instructions[1].keys[1] = { ...value.instructions[1].keys[1], isSigner: true };
    await expect(validate(value)).rejects.toThrow("flags");
  });

  it("rejects trailing transfer data", async () => {
    const value = await fixture();
    value.instructions[1].data = Buffer.concat([value.instructions[1].data, Buffer.from([1])]);
    await expect(validate(value)).rejects.toThrow("data changed");
  });

  it("rejects any changed account", async () => {
    const value = await fixture();
    value.instructions[1].keys[3] = {
      ...value.instructions[1].keys[3],
      pubkey: Keypair.generate().publicKey,
    };
    await expect(validate(value)).rejects.toThrow("account at index 3");
  });
});

describe("semanticTransactionDigest", () => {
  it("is stable for identical semantics and changes for data, keys, or flags", async () => {
    const original = await fixture();
    const same = await fixture();
    same.authority = original.authority;
    same.instructions = original.instructions.map(
      (instruction) =>
        new TransactionInstruction({
          programId: instruction.programId,
          data: Buffer.from(instruction.data),
          keys: instruction.keys.map((key) => ({ ...key })),
        }),
    );
    const digest = await semanticTransactionDigest(original.authority, original.instructions);
    expect(await semanticTransactionDigest(same.authority, same.instructions)).toBe(digest);

    same.instructions[1].keys[4].isWritable = true;
    expect(await semanticTransactionDigest(same.authority, same.instructions)).not.toBe(digest);
    same.instructions[1].keys[4].isWritable = false;
    same.instructions[1].data[17] = 1;
    expect(await semanticTransactionDigest(same.authority, same.instructions)).not.toBe(digest);
    same.instructions[1].data[17] = 0;
    same.instructions[1].keys[3].pubkey = Keypair.generate().publicKey;
    expect(await semanticTransactionDigest(same.authority, same.instructions)).not.toBe(digest);
  });
});

describe("enforceSimulatedPayerDebit", () => {
  it("accepts an exact simulated fee plus ATA-rent debit", () => {
    expect(
      enforceSimulatedPayerDebit({
        preLamports: 10_000_000,
        postLamports: 7_955_720,
        feeLamports: 5_000,
        expectedProgramDebitLamports: 2_039_280,
        maximumLamports: 3_000_000,
      }),
    ).toBe(2_044_280);
  });

  it("rejects an unexplained CPI debit even below the absolute cap", () => {
    expect(() =>
      enforceSimulatedPayerDebit({
        preLamports: 10_000_000,
        postLamports: 7_900_000,
        feeLamports: 5_000,
        expectedProgramDebitLamports: 2_039_280,
        maximumLamports: 3_000_000,
      }),
    ).toThrow("only 2044280 were reviewed");
  });

  it("rejects an exact but over-cap debit", () => {
    expect(() =>
      enforceSimulatedPayerDebit({
        preLamports: 10_000_000,
        postLamports: 5_995_000,
        feeLamports: 5_000,
        expectedProgramDebitLamports: 4_000_000,
        maximumLamports: 3_000_000,
      }),
    ).toThrow("safety cap");
  });
});

describe("decidePendingRecovery", () => {
  const base = {
    hasStatus: false,
    blockHeight: 1_000,
    lastValidBlockHeight: 1_100,
    minimumBlockheightMargin: 20,
    lastSubmissionAt: null,
    now: 50_000,
    rebroadcastIntervalMs: 10_000,
  };

  it("keeps polling an observed processed or confirmed transaction even after blockhash expiry", () => {
    expect(
      decidePendingRecovery({ ...base, hasStatus: true, blockHeight: 1_101 }),
    ).toBe("wait_for_finality");
  });

  it("expires only a status-null transaction past its last valid block height", () => {
    expect(decidePendingRecovery({ ...base, blockHeight: 1_101 })).toBe("expire");
  });

  it("does not rebroadcast inside the blockheight margin", () => {
    expect(decidePendingRecovery({ ...base, blockHeight: 1_080 })).toBe("wait_near_expiry");
  });

  it("backs off, then periodically rebroadcasts the same status-null wire bytes", () => {
    expect(decidePendingRecovery({ ...base, lastSubmissionAt: 45_000 })).toBe("wait_for_backoff");
    expect(decidePendingRecovery({ ...base, lastSubmissionAt: 40_000 })).toBe("rebroadcast");
  });
});

describe("validateCompiledTransferMessage", () => {
  it("reconstructs and validates the exact reviewed v0 transaction", async () => {
    const value = await fixture();
    const message = new TransactionMessage({
      payerKey: value.authority,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: value.instructions,
    }).compileToV0Message();

    const result = await validateCompiledTransferMessage({
      message,
      streamflowProgramId: STREAMFLOW_PROGRAM,
      authority: value.authority,
      destination: value.destination,
      contract: value.contract,
      mint: value.mint,
    });
    expect(result.destinationAta.toBase58()).toBe(getAssociatedTokenAddressSync(value.mint, value.destination).toBase58());
    expect(result.semanticDigest).toBe(await semanticTransactionDigest(value.authority, value.instructions));
  });

  it("rejects a stored destination that differs from the finalized message", async () => {
    const value = await fixture();
    const message = new TransactionMessage({
      payerKey: value.authority,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: value.instructions,
    }).compileToV0Message();

    await expect(
      validateCompiledTransferMessage({
        message,
        streamflowProgramId: STREAMFLOW_PROGRAM,
        authority: value.authority,
        destination: Keypair.generate().publicKey,
        contract: value.contract,
        mint: value.mint,
      }),
    ).rejects.toThrow("account at index 1");
  });
});

describe("validateDestinationWallet", () => {
  const systemAccount = (owner = SystemProgram.programId): AccountInfo<Buffer> => ({
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1_000_000,
    owner,
    rentEpoch: 0,
  });

  it("accepts an existing on-curve system wallet", () => {
    const destination = Keypair.generate().publicKey;
    expect(validateDestinationWallet(destination, systemAccount()).classification).toBe("on-curve system wallet");
  });

  it("rejects a nonexistent destination", () => {
    expect(() => validateDestinationWallet(Keypair.generate().publicKey, null)).toThrow("does not exist");
  });

  it("rejects a program-derived address", () => {
    const [destination] = PublicKey.findProgramAddressSync([Buffer.from("destination")], STREAMFLOW_PROGRAM);
    expect(() => validateDestinationWallet(destination, systemAccount())).toThrow("off-curve");
  });

  it("rejects token accounts and other program-owned accounts", () => {
    const destination = Keypair.generate().publicKey;
    expect(() => validateDestinationWallet(destination, systemAccount(TOKEN_PROGRAM_ID))).toThrow("token account");
    expect(() => validateDestinationWallet(destination, systemAccount(STREAMFLOW_PROGRAM))).toThrow("controlled by program");
  });
});
