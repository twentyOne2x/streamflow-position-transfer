import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_MAINNET_GENESIS_HASH,
  EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256,
  STREAMFLOW_V4_ACCOUNT_BYTES,
  STREAMFLOW_V4_PROGRAM_ID,
  appendFinalizedTransferReceipt,
  assertRawRecipientOnlyTransition,
  decodeCanonicalBase64,
  parseFinalizedTransferReceipts,
  type FinalizedTransferReceipt,
} from "./positionTransferSafety";

function rawFixture() {
  return new Uint8Array(STREAMFLOW_V4_ACCOUNT_BYTES);
}

function receiptFixture(): FinalizedTransferReceipt {
  const [contractId, source, destination, destinationAta, mint, tokenProgram] = Array.from(
    { length: 6 },
    () => Keypair.generate().publicKey.toBase58(),
  );
  return {
    schema: "streamflow-position-transfer.receipt.v1",
    signature: "1".repeat(64),
    networkGenesisHash: EXPECTED_MAINNET_GENESIS_HASH,
    streamflowProgramId: STREAMFLOW_V4_PROGRAM_ID,
    contractId,
    source,
    destination,
    destinationAta,
    mint,
    tokenProgram,
    finalizedAt: "2026-08-11T00:00:00.000Z",
    slot: 438_000_000,
    blockTime: 1_786_406_400,
    feeLamports: 5_000,
    payerDebitLamports: 5_000,
    semanticDigest: "a".repeat(64),
    signedMessageSha256: "b".repeat(64),
    programDataSha256: EXPECTED_STREAMFLOW_PROGRAM_DATA_SHA256,
    streamRawBeforeSha256: "d".repeat(64),
    streamRawAfterSha256: "e".repeat(64),
    rawChangedBytes: [113, 144, 145, 176],
  };
}

describe("assertRawRecipientOnlyTransition", () => {
  it("accepts changes across both recipient public-key fields, including their boundaries", () => {
    const before = rawFixture();
    const after = before.slice();
    for (const index of [113, 144, 145, 176]) after[index] = 1;
    expect(assertRawRecipientOnlyTransition(before, after)).toEqual([113, 144, 145, 176]);
  });

  it.each([112, 177])("rejects a raw change at byte %i", (index) => {
    const before = rawFixture();
    const after = before.slice();
    after[index] = 1;
    expect(() => assertRawRecipientOnlyTransition(before, after)).toThrow(`byte ${index}`);
  });

  it("rejects unchanged or incorrectly sized account data", () => {
    const before = rawFixture();
    expect(() => assertRawRecipientOnlyTransition(before, before.slice())).toThrow("did not change");
    expect(() => assertRawRecipientOnlyTransition(before.slice(1), before)).toThrow("1104 bytes");
    expect(() => assertRawRecipientOnlyTransition(before, before.slice(1))).toThrow("1104 bytes");
  });
});

describe("decodeCanonicalBase64", () => {
  it("round-trips canonical account bytes", () => {
    expect(Array.from(decodeCanonicalBase64("AAEC"))).toEqual([0, 1, 2]);
  });

  it.each(["", "AAEC\n", "AAE", "not-base64"])("rejects noncanonical input %j", (value) => {
    expect(() => decodeCanonicalBase64(value)).toThrow("canonical base64");
  });
});

describe("finalized receipt journal", () => {
  it("persists, parses, and idempotently deduplicates an exact receipt", () => {
    const receipt = receiptFixture();
    const once = appendFinalizedTransferReceipt(null, receipt);
    const twice = appendFinalizedTransferReceipt(once, receipt);
    expect(parseFinalizedTransferReceipts(twice)).toEqual([receipt]);
  });

  it("rejects a reused signature with different evidence", () => {
    const receipt = receiptFixture();
    const serialized = appendFinalizedTransferReceipt(null, receipt);
    expect(() =>
      appendFinalizedTransferReceipt(serialized, { ...receipt, payerDebitLamports: 6_000 }),
    ).toThrow("different evidence");
  });

  it("rejects invalid keys, hashes, costs, and changed-byte evidence", () => {
    const receipt = receiptFixture();
    expect(() => appendFinalizedTransferReceipt(null, { ...receipt, destination: "bad" })).toThrow("schema");
    expect(() => appendFinalizedTransferReceipt(null, { ...receipt, programDataSha256: "bad" })).toThrow("schema");
    expect(() => appendFinalizedTransferReceipt(null, { ...receipt, feeLamports: -1 })).toThrow("schema");
    expect(() =>
      appendFinalizedTransferReceipt(null, { ...receipt, payerDebitLamports: 3_000_001 }),
    ).toThrow("schema");
    expect(() => appendFinalizedTransferReceipt(null, { ...receipt, rawChangedBytes: [112] })).toThrow("schema");
    expect(() => appendFinalizedTransferReceipt(null, { ...receipt, rawChangedBytes: [145, 144] })).toThrow("schema");
  });
});
