#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const EXPECTED_COUNTS = Object.freeze({
  info: 0,
  low: 0,
  moderate: 4,
  high: 5,
  critical: 0,
  total: 9,
});

const EXPECTED_ADVISORIES = Object.freeze({
  "GHSA-3gc7-fjrx-p6mg": Object.freeze({
    source: 1103747,
    package: "bigint-buffer",
    severity: "high",
    range: "<=1.1.5",
  }),
  "GHSA-w5hq-g745-h8pq": Object.freeze({
    source: 1119441,
    package: "uuid",
    severity: "moderate",
    range: "<11.1.1",
  }),
});

const EXPECTED_PACKAGES = Object.freeze({
  "@coral-xyz/anchor": Object.freeze({
    severity: "moderate",
    direct: false,
    range: "*",
    via: ["@solana/web3.js"],
    roots: ["GHSA-w5hq-g745-h8pq"],
  }),
  "@solana/buffer-layout-utils": Object.freeze({
    severity: "high",
    direct: false,
    range: "*",
    via: ["@solana/web3.js", "bigint-buffer"],
    roots: ["GHSA-3gc7-fjrx-p6mg", "GHSA-w5hq-g745-h8pq"],
  }),
  "@solana/spl-token": Object.freeze({
    severity: "high",
    direct: true,
    range: ">=0.2.0-alpha.0",
    via: ["@solana/buffer-layout-utils"],
    roots: ["GHSA-3gc7-fjrx-p6mg", "GHSA-w5hq-g745-h8pq"],
  }),
  "@solana/web3.js": Object.freeze({
    severity: "moderate",
    direct: true,
    range: "<=0.0.0-pr-29130 || 0.0.4 - 1.98.4",
    via: ["jayson"],
    roots: ["GHSA-w5hq-g745-h8pq"],
  }),
  "@streamflow/common": Object.freeze({
    severity: "high",
    direct: false,
    range: "*",
    via: ["@coral-xyz/anchor", "@solana/spl-token", "@solana/web3.js"],
    roots: ["GHSA-3gc7-fjrx-p6mg", "GHSA-w5hq-g745-h8pq"],
  }),
  "@streamflow/stream": Object.freeze({
    severity: "high",
    direct: true,
    range: "3.0.1-3.1 || >=3.0.3-test.0",
    via: [
      "@coral-xyz/anchor",
      "@solana/spl-token",
      "@solana/web3.js",
      "@streamflow/common",
    ],
    roots: ["GHSA-3gc7-fjrx-p6mg", "GHSA-w5hq-g745-h8pq"],
  }),
  "bigint-buffer": Object.freeze({
    severity: "high",
    direct: false,
    range: "*",
    via: ["GHSA-3gc7-fjrx-p6mg"],
    roots: ["GHSA-3gc7-fjrx-p6mg"],
  }),
  jayson: Object.freeze({
    severity: "moderate",
    direct: false,
    range: ">=2.0.6",
    via: ["uuid"],
    roots: ["GHSA-w5hq-g745-h8pq"],
  }),
  uuid: Object.freeze({
    severity: "moderate",
    direct: false,
    range: "<11.1.1",
    via: ["GHSA-w5hq-g745-h8pq"],
    roots: ["GHSA-w5hq-g745-h8pq"],
  }),
});

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function ghsaFromUrl(url) {
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)$/.exec(url);
  return match?.[1] ?? null;
}

function directViaIds(vulnerability, packageName, failures, observedAdvisories) {
  if (!Array.isArray(vulnerability.via)) {
    failures.push(`${packageName}: via must be an array`);
    return [];
  }

  return vulnerability.via.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }

    if (entry === null || typeof entry !== "object") {
      failures.push(`${packageName}: via contains an invalid entry`);
      return [];
    }

    const advisoryId = ghsaFromUrl(entry.url);
    if (advisoryId === null) {
      failures.push(`${packageName}: advisory URL is not a canonical GitHub advisory URL`);
      return [];
    }

    const expected = EXPECTED_ADVISORIES[advisoryId];
    if (expected === undefined) {
      failures.push(`${packageName}: unexpected advisory ${advisoryId}`);
      return [advisoryId];
    }

    observedAdvisories.add(advisoryId);
    if (
      entry.source !== expected.source ||
      entry.name !== expected.package ||
      entry.dependency !== expected.package ||
      entry.severity !== expected.severity ||
      entry.range !== expected.range ||
      packageName !== expected.package
    ) {
      failures.push(`${packageName}: metadata drifted for ${advisoryId}`);
    }

    return [advisoryId];
  });
}

function resolveRootAdvisories(packageName, directVia, failures, trail = []) {
  if (trail.includes(packageName)) {
    failures.push(`dependency cycle while resolving ${[...trail, packageName].join(" -> ")}`);
    return new Set();
  }

  const roots = new Set();
  for (const item of directVia[packageName] ?? []) {
    if (item.startsWith("GHSA-")) {
      roots.add(item);
      continue;
    }

    if (!(item in directVia)) {
      failures.push(`${packageName}: via references unreported package ${item}`);
      continue;
    }

    for (const root of resolveRootAdvisories(item, directVia, failures, [...trail, packageName])) {
      roots.add(root);
    }
  }
  return roots;
}

export function validateAuditReport(report) {
  const failures = [];
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return ["audit output must be a JSON object"];
  }

  if (report.auditReportVersion !== 2) {
    failures.push(`auditReportVersion must be 2, received ${String(report.auditReportVersion)}`);
  }

  const vulnerabilities = report.vulnerabilities;
  if (vulnerabilities === null || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities)) {
    failures.push("vulnerabilities must be an object");
    return failures;
  }

  const actualPackages = Object.keys(vulnerabilities);
  const expectedPackages = Object.keys(EXPECTED_PACKAGES);
  if (!sameStrings(actualPackages, expectedPackages)) {
    failures.push(
      `affected package set drifted; expected [${sorted(expectedPackages).join(", ")}], received [${sorted(actualPackages).join(", ")}]`,
    );
  }

  const counts = report.metadata?.vulnerabilities;
  if (
    counts === null ||
    typeof counts !== "object" ||
    Array.isArray(counts) ||
    !sameStrings(Object.keys(counts), Object.keys(EXPECTED_COUNTS))
  ) {
    failures.push("vulnerability count categories drifted");
  }
  for (const [severity, expectedCount] of Object.entries(EXPECTED_COUNTS)) {
    if (counts?.[severity] !== expectedCount) {
      failures.push(`${severity} count must be ${expectedCount}, received ${String(counts?.[severity])}`);
    }
  }

  const directVia = {};
  const observedAdvisories = new Set();
  for (const [packageName, expected] of Object.entries(EXPECTED_PACKAGES)) {
    const vulnerability = vulnerabilities[packageName];
    if (vulnerability === null || typeof vulnerability !== "object" || Array.isArray(vulnerability)) {
      failures.push(`${packageName}: missing vulnerability record`);
      continue;
    }

    if (vulnerability.name !== packageName) {
      failures.push(`${packageName}: record name must match package key`);
    }
    if (vulnerability.severity !== expected.severity) {
      failures.push(`${packageName}: severity must be ${expected.severity}, received ${String(vulnerability.severity)}`);
    }
    if (vulnerability.isDirect !== expected.direct) {
      failures.push(`${packageName}: isDirect must be ${expected.direct}, received ${String(vulnerability.isDirect)}`);
    }
    if (vulnerability.range !== expected.range) {
      failures.push(`${packageName}: range must be ${expected.range}, received ${String(vulnerability.range)}`);
    }

    directVia[packageName] = directViaIds(
      vulnerability,
      packageName,
      failures,
      observedAdvisories,
    );
    if (!sameStrings(directVia[packageName], expected.via)) {
      failures.push(
        `${packageName}: via graph drifted; expected [${sorted(expected.via).join(", ")}], received [${sorted(directVia[packageName]).join(", ")}]`,
      );
    }
  }

  const expectedAdvisories = Object.keys(EXPECTED_ADVISORIES);
  if (!sameStrings(observedAdvisories, expectedAdvisories)) {
    failures.push(
      `root advisory set drifted; expected [${sorted(expectedAdvisories).join(", ")}], received [${sorted(observedAdvisories).join(", ")}]`,
    );
  }

  for (const [packageName, expected] of Object.entries(EXPECTED_PACKAGES)) {
    const roots = resolveRootAdvisories(packageName, directVia, failures);
    if (!sameStrings(roots, expected.roots)) {
      failures.push(
        `${packageName}: root advisories drifted; expected [${sorted(expected.roots).join(", ")}], received [${sorted(roots).join(", ")}]`,
      );
    }
  }

  return failures;
}

function run() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error !== undefined || result.signal !== null) {
    console.error(`Could not complete npm audit: ${result.error?.message ?? `terminated by ${result.signal}`}`);
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error("npm audit did not return valid JSON; refusing to accept the advisory baseline.");
    process.exitCode = 1;
    return;
  }

  const failures = validateAuditReport(report);
  if (result.status !== 1) {
    failures.unshift(`npm audit exit status must be 1 for this unresolved baseline, received ${String(result.status)}`);
  }

  if (failures.length > 0) {
    console.error("Production dependency advisory baseline changed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    console.error("Review and explicitly update the allowlist; do not bypass this gate.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "Known unresolved production advisory baseline unchanged: 9 affected packages (5 high, 4 moderate), rooted in GHSA-3gc7-fjrx-p6mg and GHSA-w5hq-g745-h8pq.",
  );
}

const entrypoint = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  run();
}
