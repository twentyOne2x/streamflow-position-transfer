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
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_MAINNET_GENESIS_HASH,
  EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256,
  STREAMFLOW_V4_PROGRAM_ID,
  type FinalizedTransferReceipt,
} from "./positionTransferSafety";
import { verifyFinalizedTransferReceipt } from "./receiptVerification";
import { semanticTransactionDigest, sha256Bytes, sha256Hex } from "./transactionSafety";

async function fixture() {
  const source = Keypair.generate();
  const destination = Keypair.generate().publicKey;
  const contract = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const destinationAta = getAssociatedTokenAddressSync(mint, destination);
  const discriminator = (await sha256Bytes(new TextEncoder().encode("global:transfer_recipient"))).slice(0, 8);
  const transferData = new Uint8Array(18);
  transferData.set(discriminator);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_001 }),
    new TransactionInstruction({
      programId: new PublicKey(STREAMFLOW_V4_PROGRAM_ID),
      data: Buffer.from(transferData),
      keys: [
        { pubkey: source.publicKey, isSigner: true, isWritable: true },
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
  ];
  const message = new TransactionMessage({
    payerKey: source.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([source]);
  const signature = bs58.encode(transaction.signatures[0]);
  const receipt: FinalizedTransferReceipt = {
    schema: "streamflow-position-transfer.receipt.v1",
    signature,
    networkGenesisHash: EXPECTED_MAINNET_GENESIS_HASH,
    streamflowProgramId: STREAMFLOW_V4_PROGRAM_ID,
    contractId: contract.toBase58(),
    source: source.publicKey.toBase58(),
    destination: destination.toBase58(),
    destinationAta: destinationAta.toBase58(),
    mint: mint.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    finalizedAt: "2026-08-11T00:00:00.000Z",
    slot: 438_000_000,
    blockTime: 1_786_406_400,
    feeLamports: 5_000,
    payerDebitLamports: 5_000,
    semanticDigest: await semanticTransactionDigest(source.publicKey, instructions),
    signedMessageSha256: await sha256Hex(message.serialize()),
    programDataSha256: EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256,
    streamRawBeforeSha256: "d".repeat(64),
    streamRawAfterSha256: "e".repeat(64),
    rawChangedBytes: [113, 144, 145, 176],
  };
  const finalized = {
    slot: receipt.slot,
    blockTime: receipt.blockTime,
    transaction: { message, signatures: [signature] },
    meta: { err: null, fee: 5_000, preBalances: [10_000_000], postBalances: [9_995_000] },
  };
  const connection = {
    getGenesisHash: async () => EXPECTED_MAINNET_GENESIS_HASH,
    getTransaction: async () => finalized,
  } as unknown as Connection;
  return { receipt, connection, finalized };
}

describe("verifyFinalizedTransferReceipt", () => {
  it("authenticates the finalized message, signature, semantics, fee, and payer debit", async () => {
    const value = await fixture();
    await expect(verifyFinalizedTransferReceipt(value.connection, value.receipt)).resolves.toEqual({
      slot: value.receipt.slot,
      blockTime: value.receipt.blockTime,
    });
  });

  it("rejects forged local receipt evidence", async () => {
    const value = await fixture();
    await expect(
      verifyFinalizedTransferReceipt(value.connection, {
        ...value.receipt,
        signedMessageSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("message hash");
  });

  it("rejects mismatched finalized costs", async () => {
    const value = await fixture();
    value.finalized.meta.postBalances[0] -= 1;
    await expect(verifyFinalizedTransferReceipt(value.connection, value.receipt)).rejects.toThrow(
      "only 5000 were reviewed",
    );
  });
});
