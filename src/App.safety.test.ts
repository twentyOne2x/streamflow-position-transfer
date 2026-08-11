import { describe, expect, it } from "vitest";

import source from "./App.tsx?raw";

describe("standalone transfer workflow", () => {
  it("starts with neutral contract and destination inputs", () => {
    expect(source).toContain('const [contractId, setContractId] = useState("")');
    expect(source).toContain('const [destination, setDestination] = useState("")');
    expect(source).toContain('placeholder="Streamflow contract address"');
    expect(source).toContain('placeholder="New recipient wallet address"');
    expect(source).not.toMatch(/SOURCE_WALLET|TOKEN_MINT|POSITION_IDS|DEFAULT_DESTINATION/);
  });

  it("derives identity and token details from decoded contract state", () => {
    expect(source).toContain("if (stream.recipient !== source)");
    expect(source).toContain("if (!stream.transferableByRecipient)");
    expect(source).toContain("mint: stream.mint");
    expect(source).toContain("tokenProgram: validation.tokenProgram.toBase58()");
  });

  it("rejects unusable existing or newly created destination ATAs at every send phase", () => {
    expect(source.match(/assertDestinationTokenAccountUsable\(/g)).toHaveLength(3);
    expect(source.match(/assertNewDestinationTokenAccountUsable\(/g)).toHaveLength(3);
  });

  it("keeps simulation, signing, and broadcast as separate actions", () => {
    expect(source).toContain("const simulate = async () =>");
    expect(source).toContain("const sign = async () =>");
    expect(source).toContain("const broadcast = async () =>");
    expect(source.match(/simulateTransaction\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/sendRawTransaction\(/g)).toHaveLength(2);
  });

  it("arms validated pending bytes and rechecks them before submission", () => {
    const broadcastStart = source.indexOf("const broadcastWithOwnership = async () =>");
    const prepareAndArm = source.indexOf("prepareAndArmTransfer({", broadcastStart);
    const armedRecheck = source.indexOf("await assertArmedPendingUnchanged(retainedPending)", prepareAndArm);
    const initialSubmit = source.indexOf("connection.sendRawTransaction(signedTransfer.wireTransaction", broadcastStart);
    expect(broadcastStart).toBeGreaterThan(-1);
    expect(prepareAndArm).toBeGreaterThan(broadcastStart);
    expect(armedRecheck).toBeGreaterThan(prepareAndArm);
    expect(initialSubmit).toBeGreaterThan(armedRecheck);
  });

  it("persists a receipt before clearing pending state", () => {
    const receiptStart = source.indexOf("const durableReceipt: Receipt");
    const receiptWrite = source.indexOf("window.localStorage.setItem(FINALIZED_RECEIPTS_KEY", receiptStart);
    const pendingClear = source.indexOf("clearPending();", receiptStart);
    expect(receiptStart).toBeGreaterThan(-1);
    expect(receiptWrite).toBeGreaterThan(receiptStart);
    expect(pendingClear).toBeGreaterThan(receiptWrite);
  });

  it("uses the global journal lock for initial broadcast, recovery, and draft cleanup", () => {
    expect(source.match(/navigator\.locks\.request\(\s*BROADCAST_LOCK_KEY/g)).toHaveLength(4);
    expect(source).toContain("discardPreparedTransfer(window.localStorage)");
  });

  it("treats only finalized transaction errors as terminal", () => {
    expect(source).not.toContain("if (status.value?.err)");
    const finalizedBranch = source.indexOf("if (isFinalizedStatus(status.value))");
    const semanticValidation = source.indexOf("finalizedValidation.semanticDigest", finalizedBranch);
    const terminalError = source.indexOf("if (finalized.meta?.err)", finalizedBranch);
    expect(semanticValidation).toBeGreaterThan(finalizedBranch);
    expect(terminalError).toBeGreaterThan(semanticValidation);
  });

  it("requires a finalized raw baseline before clearing an expired status-null record", () => {
    const expiryBranch = source.indexOf('if (recoveryAction === "expire")');
    const baselineGate = source.indexOf("requireFinalizedBaselineBeforeExpiryClear", expiryBranch);
    const pendingClear = source.indexOf("clearPending();", baselineGate);
    expect(expiryBranch).toBeGreaterThan(-1);
    expect(baselineGate).toBeGreaterThan(expiryBranch);
    expect(pendingClear).toBeGreaterThan(baselineGate);
  });

  it("renders retained receipts as verified only after on-chain authentication", () => {
    expect(source).toContain("verifyFinalizedTransferReceipt(connection, receipt)");
    expect(source).toContain('receipt && receiptVerification === "verified"');
    expect(source).toContain('receipt && receiptVerification === "verifying"');
  });
});
