export const PENDING_PREPARED_KEY = "streamflow-position-transfer.prepared.v1";
export const PENDING_BROADCAST_KEY = "streamflow-position-transfer.pending.v1";
export const BROADCAST_LOCK_KEY = "streamflow-position-transfer:mainnet:broadcast";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TransferJournalSnapshot<T> =
  | { phase: "empty" }
  | { phase: "prepared"; serialized: string }
  | { phase: "armed"; serialized: string; value: T }
  | { phase: "invalid"; serialized: string; error: unknown };

export function hasTransferJournalRecord(storage: StorageLike) {
  return Boolean(storage.getItem(PENDING_BROADCAST_KEY) || storage.getItem(PENDING_PREPARED_KEY));
}

export function readTransferJournal<T>(
  storage: StorageLike,
  parseArmed: (serialized: string) => T,
): TransferJournalSnapshot<T> {
  const armed = storage.getItem(PENDING_BROADCAST_KEY);
  if (armed) {
    try {
      return { phase: "armed", serialized: armed, value: parseArmed(armed) };
    } catch (error) {
      return { phase: "invalid", serialized: armed, error };
    }
  }
  const prepared = storage.getItem(PENDING_PREPARED_KEY);
  return prepared ? { phase: "prepared", serialized: prepared } : { phase: "empty" };
}

export function recoveryCandidate<T>(snapshot: TransferJournalSnapshot<T>) {
  return snapshot.phase === "armed" ? snapshot.value : null;
}

export async function prepareAndArmTransfer<T>({
  storage,
  serialized,
  parse,
  validate,
  assertStillCurrent,
  onPrepared,
}: {
  storage: StorageLike;
  serialized: string;
  parse: (value: string) => T;
  validate: (value: T) => Promise<void>;
  assertStillCurrent: () => void | Promise<void>;
  onPrepared?: () => void;
}) {
  if (hasTransferJournalRecord(storage)) {
    throw new Error("Another retained transfer exists. Nothing was submitted.");
  }

  storage.setItem(PENDING_PREPARED_KEY, serialized);
  onPrepared?.();
  const persistedSerialized = storage.getItem(PENDING_PREPARED_KEY);
  if (persistedSerialized !== serialized) {
    throw new Error("Prepared transfer did not persist exactly. Nothing was submitted.");
  }
  const persisted = parse(persistedSerialized);
  await validate(persisted);
  if (JSON.stringify(persisted) !== serialized || storage.getItem(PENDING_PREPARED_KEY) !== serialized) {
    throw new Error("Prepared transfer changed during validation. Nothing was submitted.");
  }

  await assertStillCurrent();
  if (storage.getItem(PENDING_BROADCAST_KEY)) {
    throw new Error("Another armed transfer exists. Nothing was submitted.");
  }
  storage.setItem(PENDING_BROADCAST_KEY, serialized);
  if (storage.getItem(PENDING_BROADCAST_KEY) !== serialized) {
    storage.removeItem(PENDING_BROADCAST_KEY);
    throw new Error("Armed transfer storage changed at commit. Nothing was submitted.");
  }
  storage.removeItem(PENDING_PREPARED_KEY);
  return persisted;
}

export function assertArmedTransferUnchanged(storage: StorageLike, serialized: string) {
  if (storage.getItem(PENDING_BROADCAST_KEY) !== serialized) {
    throw new Error("The armed pending record changed during reconciliation.");
  }
}

export function discardPreparedTransfer(storage: StorageLike) {
  if (storage.getItem(PENDING_BROADCAST_KEY)) {
    throw new Error("An armed transfer exists and cannot be discarded as an unarmed draft.");
  }
  storage.removeItem(PENDING_PREPARED_KEY);
  if (storage.getItem(PENDING_PREPARED_KEY)) {
    throw new Error("The unarmed draft could not be removed from local storage.");
  }
}

export function isFinalizedStatus(status: { confirmationStatus?: string | null } | null) {
  return status?.confirmationStatus === "finalized";
}

export async function requireFinalizedBaselineBeforeExpiryClear(
  recoveryAction: string,
  verifyFinalizedBaseline: () => Promise<void>,
) {
  if (recoveryAction !== "expire") return false;
  await verifyFinalizedBaseline();
  return true;
}
