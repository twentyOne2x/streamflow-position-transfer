import { Keypair, PublicKey } from "@solana/web3.js";
import type { Stream } from "@streamflow/stream";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_STREAM_FIELDS,
  assertExactStreamSnapshot,
  assertRecipientOnlyTransition,
  snapshotStream,
  type StreamInvariant,
} from "./streamState";

function streamFixture() {
  const stream = Object.fromEntries(REQUIRED_STREAM_FIELDS.map((field) => [field, 0])) as Record<string, unknown>;
  Object.assign(stream, {
    isAligned: false,
    sender: Keypair.generate().publicKey.toBase58(),
    senderTokens: Keypair.generate().publicKey.toBase58(),
    recipient: Keypair.generate().publicKey.toBase58(),
    recipientTokens: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    escrowTokens: Keypair.generate().publicKey.toBase58(),
    oldMetadata: Keypair.generate().publicKey,
    withdrawnAmount: { toString: () => "1" },
    depositedAmount: { toString: () => "100" },
    name: "fixture",
    type: "lock",
  });
  return stream;
}

describe("snapshotStream", () => {
  it("captures every decoded enumerable field in a canonical form", () => {
    const fixture = streamFixture();
    fixture.futureDecodedField = { toString: () => "future-value" };
    const snapshot = snapshotStream(fixture as unknown as Stream);
    expect(snapshot.futureDecodedField).toBe("future-value");
    expect(snapshot.oldMetadata).toBe((fixture.oldMetadata as PublicKey).toBase58());
    expect(Object.keys(snapshot)).toEqual([...Object.keys(snapshot)].sort((left, right) => left.localeCompare(right)));
  });

  it("fails closed if the SDK omits a required decoded field", () => {
    const fixture = streamFixture();
    delete fixture.partnerFeeWithdrawn;
    expect(() => snapshotStream(fixture as unknown as Stream)).toThrow("partnerFeeWithdrawn");
  });
});

describe("assertRecipientOnlyTransition", () => {
  it("allows exactly the recipient and recipient-token-account transition", () => {
    const before = snapshotStream(streamFixture() as unknown as Stream);
    const destination = Keypair.generate().publicKey.toBase58();
    const destinationAta = Keypair.generate().publicKey.toBase58();
    const after: StreamInvariant = { ...before, recipient: destination, recipientTokens: destinationAta };
    expect(() => assertRecipientOnlyTransition(before, after, destination, destinationAta)).not.toThrow();
  });

  it("rejects a mutation in any other decoded field", () => {
    const before = snapshotStream(streamFixture() as unknown as Stream);
    const destination = Keypair.generate().publicKey.toBase58();
    const destinationAta = Keypair.generate().publicKey.toBase58();
    const after: StreamInvariant = {
      ...before,
      recipient: destination,
      recipientTokens: destinationAta,
      streamflowFeeWithdrawn: "999",
    };
    expect(() => assertRecipientOnlyTransition(before, after, destination, destinationAta)).toThrow(
      "streamflowFeeWithdrawn",
    );
  });

  it("rejects a changed decoded field set or unexpected recipient ATA", () => {
    const before = snapshotStream(streamFixture() as unknown as Stream);
    const destination = Keypair.generate().publicKey.toBase58();
    const destinationAta = Keypair.generate().publicKey.toBase58();
    const missingField: StreamInvariant = { ...before, recipient: destination, recipientTokens: destinationAta };
    delete missingField["partner"];
    expect(() => assertRecipientOnlyTransition(before, missingField, destination, destinationAta)).toThrow("field set");

    const wrongAta = { ...before, recipient: destination, recipientTokens: Keypair.generate().publicKey.toBase58() };
    expect(() => assertRecipientOnlyTransition(before, wrongAta, destination, destinationAta)).toThrow(
      "recipient token account",
    );
  });
});

describe("assertExactStreamSnapshot", () => {
  it("rejects changes to any decoded field", () => {
    const expected = snapshotStream(streamFixture() as unknown as Stream);
    expect(() => assertExactStreamSnapshot(expected, { ...expected }, "stream")).not.toThrow();
    expect(() =>
      assertExactStreamSnapshot(expected, { ...expected, partnerFeeWithdrawn: "1" }, "stream"),
    ).toThrow("partnerFeeWithdrawn");
  });
});
