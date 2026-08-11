import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateAuditReport } from "./audit-allowlist.mjs";

function advisory(id, source, name, severity, range) {
  return {
    source,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range,
  };
}

function record(name, severity, isDirect, range, via) {
  return { name, severity, isDirect, range, via, effects: [], nodes: [] };
}

function baseline() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "@coral-xyz/anchor": record("@coral-xyz/anchor", "moderate", false, "*", ["@solana/web3.js"]),
      "@solana/buffer-layout-utils": record("@solana/buffer-layout-utils", "high", false, "*", [
        "@solana/web3.js",
        "bigint-buffer",
      ]),
      "@solana/spl-token": record("@solana/spl-token", "high", true, ">=0.2.0-alpha.0", [
        "@solana/buffer-layout-utils",
      ]),
      "@solana/web3.js": record(
        "@solana/web3.js",
        "moderate",
        true,
        "<=0.0.0-pr-29130 || 0.0.4 - 1.98.4",
        ["jayson"],
      ),
      "@streamflow/common": record("@streamflow/common", "high", false, "*", [
        "@coral-xyz/anchor",
        "@solana/spl-token",
        "@solana/web3.js",
      ]),
      "@streamflow/stream": record(
        "@streamflow/stream",
        "high",
        true,
        "3.0.1-3.1 || >=3.0.3-test.0",
        ["@coral-xyz/anchor", "@solana/spl-token", "@solana/web3.js", "@streamflow/common"],
      ),
      "bigint-buffer": record("bigint-buffer", "high", false, "*", [
        advisory("GHSA-3gc7-fjrx-p6mg", 1103747, "bigint-buffer", "high", "<=1.1.5"),
      ]),
      jayson: record("jayson", "moderate", false, ">=2.0.6", ["uuid"]),
      uuid: record("uuid", "moderate", false, "<11.1.1", [
        advisory("GHSA-w5hq-g745-h8pq", 1119441, "uuid", "moderate", "<11.1.1"),
      ]),
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 4, high: 5, critical: 0, total: 9 },
    },
  };
}

describe("production advisory allowlist", () => {
  it("accepts the exact known unresolved baseline", () => {
    assert.deepEqual(validateAuditReport(baseline()), []);
  });

  it("fails closed when an advisory changes", () => {
    const report = baseline();
    report.vulnerabilities.uuid.via[0].url = "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";

    assert.match(
      validateAuditReport(report).join("\n"),
      /unexpected advisory GHSA-aaaa-bbbb-cccc/,
    );
  });

  it("fails closed when the affected package set changes", () => {
    const report = baseline();
    report.vulnerabilities["new-package"] = record("new-package", "high", false, "*", ["uuid"]);

    assert.match(validateAuditReport(report).join("\n"), /affected package set drifted/);
  });

  it("fails closed when severity counts change", () => {
    const report = baseline();
    report.metadata.vulnerabilities.high = 6;
    report.metadata.vulnerabilities.total = 10;

    const failures = validateAuditReport(report).join("\n");
    assert.match(failures, /high count must be 5/);
    assert.match(failures, /total count must be 9/);
  });

  it("fails closed when a count category appears", () => {
    const report = baseline();
    report.metadata.vulnerabilities.unknown = 0;

    assert.match(validateAuditReport(report).join("\n"), /count categories drifted/);
  });

  it("fails closed when the dependency path changes", () => {
    const report = baseline();
    report.vulnerabilities.jayson.via = ["bigint-buffer"];

    const failures = validateAuditReport(report).join("\n");
    assert.match(failures, /jayson: via graph drifted/);
    assert.match(failures, /jayson: root advisories drifted/);
  });
});
