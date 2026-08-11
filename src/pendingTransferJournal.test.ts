import { describe, expect, it, vi } from "vitest";

import { decidePendingRecovery } from "./transactionSafety";
import {
  BROADCAST_LOCK_KEY,
  PENDING_BROADCAST_KEY,
  PENDING_PREPARED_KEY,
  assertArmedTransferUnchanged,
  discardPreparedTransfer,
  isFinalizedStatus,
  prepareAndArmTransfer,
  readTransferJournal,
  recoveryCandidate,
  requireFinalizedBaselineBeforeExpiryClear,
} from "./pendingTransferJournal";

function storageFixture(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const parse = (serialized: string) => JSON.parse(serialized) as { contractId: string };

describe("pending transfer journal", () => {
  it("never exposes a prepared reload as a recovery submission candidate", () => {
    const storage = storageFixture({ [PENDING_PREPARED_KEY]: '{"contractId":"position-a"}' });
    const snapshot = readTransferJournal(storage, parse);
    expect(snapshot.phase).toBe("prepared");
    expect(recoveryCandidate(snapshot)).toBeNull();
  });

  it("exposes only a valid armed reload as a recovery candidate", () => {
    const storage = storageFixture({ [PENDING_BROADCAST_KEY]: '{"contractId":"position-a"}' });
    const snapshot = readTransferJournal(storage, parse);
    expect(snapshot.phase).toBe("armed");
    expect(recoveryCandidate(snapshot)).toEqual({ contractId: "position-a" });
  });

  it("cancels recovery when an armed replacement is invalid", () => {
    const storage = storageFixture({ [PENDING_BROADCAST_KEY]: "not-json" });
    const snapshot = readTransferJournal(storage, parse);
    expect(snapshot.phase).toBe("invalid");
    expect(recoveryCandidate(snapshot)).toBeNull();
  });

  it("validates the exact prepared bytes before arming them", async () => {
    const storage = storageFixture();
    const serialized = '{"contractId":"position-a"}';
    const validate = vi.fn(async () => undefined);
    const assertStillCurrent = vi.fn();

    await expect(
      prepareAndArmTransfer({ storage, serialized, parse, validate, assertStillCurrent }),
    ).resolves.toEqual({ contractId: "position-a" });
    expect(validate).toHaveBeenCalledBefore(assertStillCurrent);
    expect(storage.getItem(PENDING_PREPARED_KEY)).toBeNull();
    expect(storage.getItem(PENDING_BROADCAST_KEY)).toBe(serialized);
  });

  it("detects a journal mutation after arming and before submission", async () => {
    const storage = storageFixture();
    const serialized = '{"contractId":"position-a"}';
    await prepareAndArmTransfer({
      storage,
      serialized,
      parse,
      validate: async () => undefined,
      assertStillCurrent: () => undefined,
    });
    storage.setItem(PENDING_BROADCAST_KEY, '{"contractId":"position-b"}');
    expect(() => assertArmedTransferUnchanged(storage, serialized)).toThrow("changed");
  });

  it("uses one global lock name for every contract and protects draft deletion", () => {
    expect(BROADCAST_LOCK_KEY).toBe("streamflow-position-transfer:mainnet:broadcast");
    const storage = storageFixture({
      [PENDING_PREPARED_KEY]: '{"contractId":"position-a"}',
      [PENDING_BROADCAST_KEY]: '{"contractId":"position-b"}',
    });
    expect(() => discardPreparedTransfer(storage)).toThrow("armed transfer");
    expect(storage.getItem(PENDING_PREPARED_KEY)).not.toBeNull();
  });

  it("retains a processed or confirmed error until finality", () => {
    expect(isFinalizedStatus({ confirmationStatus: "confirmed" })).toBe(false);
    expect(
      decidePendingRecovery({
        hasStatus: true,
        blockHeight: 1_101,
        lastValidBlockHeight: 1_100,
        minimumBlockheightMargin: 20,
        lastSubmissionAt: null,
        now: 50_000,
        rebroadcastIntervalMs: 10_000,
      }),
    ).toBe("wait_for_finality");
  });

  it("requires finalized baseline verification before an expired record can clear", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(requireFinalizedBaselineBeforeExpiryClear("expire", verify)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledOnce();

    await expect(
      requireFinalizedBaselineBeforeExpiryClear("expire", async () => {
        throw new Error("baseline changed");
      }),
    ).rejects.toThrow("baseline changed");
  });
});
