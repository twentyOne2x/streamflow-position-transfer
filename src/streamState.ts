import { PublicKey } from "@solana/web3.js";
import type { Stream } from "@streamflow/stream";

export type StreamSnapshotValue = string | number | boolean | null;
export type StreamInvariant = Record<string, StreamSnapshotValue> & {
  mint: string;
  recipient: string;
  recipientTokens: string;
};

export const REQUIRED_STREAM_FIELDS = [
  "isAligned",
  "magic",
  "version",
  "createdAt",
  "withdrawnAmount",
  "canceledAt",
  "end",
  "lastWithdrawnAt",
  "sender",
  "senderTokens",
  "recipient",
  "recipientTokens",
  "mint",
  "escrowTokens",
  "streamflowTreasury",
  "streamflowTreasuryTokens",
  "streamflowFeeTotal",
  "streamflowFeeWithdrawn",
  "streamflowFeePercent",
  "partnerFeeTotal",
  "partnerFeeWithdrawn",
  "partnerFeePercent",
  "partner",
  "partnerTokens",
  "start",
  "depositedAmount",
  "period",
  "amountPerPeriod",
  "cliff",
  "cliffAmount",
  "cancelableBySender",
  "cancelableByRecipient",
  "automaticWithdrawal",
  "transferableBySender",
  "transferableByRecipient",
  "canTopup",
  "name",
  "withdrawalFrequency",
  "isPda",
  "nonce",
  "closed",
  "currentPauseStart",
  "pauseCumulative",
  "lastRateChangeTime",
  "fundsUnlockedAtLastRateChange",
  "oldMetadata",
  "payer",
  "bump",
  "feePartner",
  "cancelRequestTime",
  "type",
] as const;

function canonicalSnapshotValue(field: string, value: unknown): StreamSnapshotValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === "object") {
    const candidate = value as { toBase58?: () => string; toString?: () => string };
    if (typeof candidate.toBase58 === "function") return candidate.toBase58();
    if (typeof candidate.toString === "function") {
      const encoded = candidate.toString();
      if (encoded !== "[object Object]") return encoded;
    }
  }
  throw new Error(`Unsupported decoded Streamflow field ${field}.`);
}

export function snapshotStream(stream: Stream): StreamInvariant {
  const source = stream as unknown as Record<string, unknown>;
  for (const field of REQUIRED_STREAM_FIELDS) {
    if (!(field in source)) throw new Error(`Decoded Streamflow state is missing ${field}.`);
  }
  const snapshot = Object.fromEntries(
    Object.entries(source)
      .filter(([, value]) => typeof value !== "function" && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, value]) => [field, canonicalSnapshotValue(field, value)]),
  ) as StreamInvariant;
  if (
    typeof snapshot.mint !== "string" ||
    typeof snapshot.recipient !== "string" ||
    typeof snapshot.recipientTokens !== "string"
  ) {
    throw new Error("Decoded Streamflow identity fields are invalid.");
  }
  return snapshot;
}

export function assertRecipientOnlyTransition(
  before: StreamInvariant,
  after: StreamInvariant,
  destination: string,
  destinationAta: string,
) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    throw new Error("Decoded Streamflow field set changed during transfer.");
  }
  if (after.recipient !== destination) {
    throw new Error(`Final recipient is ${after.recipient}, not the reviewed destination.`);
  }
  if (after.recipientTokens !== destinationAta) {
    throw new Error(`Final recipient token account is ${after.recipientTokens}, not the reviewed destination ATA.`);
  }
  for (const key of beforeKeys) {
    if (key === "recipient" || key === "recipientTokens") continue;
    if (before[key] !== after[key]) throw new Error(`Streamflow field ${key} changed during recipient transfer.`);
  }
}

export function assertExactStreamSnapshot(expected: StreamInvariant, actual: StreamInvariant, label: string) {
  const keys = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
  for (const key of keys) {
    if (expected[key] !== actual[key]) {
      throw new Error(`${label} field ${key} changed.`);
    }
  }
}
