#!/usr/bin/env node

/**
 * Run the complete Milestone 4 generic reference-consumer gate.
 *
 * This gate is deliberately Node-only and fail-closed. It does not require a
 * Rewards Optimizer application, PostgreSQL, or any Agent Feed server package.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = join(ROOT, "examples/rewards-optimizer");
const SDK_ROOT = join(ROOT, "packages/sdk/typescript");
const failures = [];

function acceptanceSkipCount(output) {
  let count = 0;
  for (const match of output.matchAll(/^\s*ℹ\s+skipped\s+(\d+)\s*$/gimu)) count += Number(match[1]);
  count += (output.match(/^\s*#\s*SKIP\b/gimu) ?? []).length;
  return count;
}

function run(label, command, args, cwd = ROOT, { test = false, env = process.env } = {}) {
  console.log(`\n[M4] ${label}`);
  console.log(`      ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
  else if (test && acceptanceSkipCount(output) > 0) failures.push(`${label}: acceptance tests were skipped`);
  return result.status === 0;
}

function packageTestFiles() {
  const directory = join(PACKAGE_ROOT, "test");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.mjs"))
    .sort();
}

const manifestPath = join(PACKAGE_ROOT, "package.json");
const sdkManifestPath = join(SDK_ROOT, "package.json");
if (!existsSync(sdkManifestPath)) {
  failures.push("packages/sdk/typescript/package.json is missing");
} else {
  try {
    const sdkManifest = JSON.parse(readFileSync(sdkManifestPath, "utf8"));
    if (sdkManifest.name !== "@agent-feed/sdk") failures.push("public TypeScript SDK package identity is invalid");
    if (typeof sdkManifest.scripts?.build !== "string") failures.push("public TypeScript SDK build script is missing");
  } catch (error) {
    failures.push(`public TypeScript SDK manifest is invalid: ${error instanceof Error ? error.message : "parse error"}`);
  }
}
if (!existsSync(manifestPath)) {
  failures.push("examples/rewards-optimizer/package.json is missing");
} else {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.scripts?.build !== "string") failures.push("reference package build script is missing");
    if (typeof manifest.scripts?.test !== "string") failures.push("reference package test script is missing");
    if (typeof manifest.exports?.["."] !== "object") failures.push("reference package public export is missing");
  } catch (error) {
    failures.push(`reference package manifest is invalid: ${error instanceof Error ? error.message : "parse error"}`);
  }
}
if (packageTestFiles().length === 0) failures.push("reference package has no focused test files");

run("architecture guard", process.execPath, ["scripts/check_m4_architecture.mjs"]);
run("architecture tests", process.execPath, ["--test", "tests/m4/architecture.test.mjs"], ROOT, { test: true });
run("public TypeScript SDK dependency build", "npm", ["run", "build"], SDK_ROOT);
run("reference package clean build", "npm", ["run", "build"], PACKAGE_ROOT);
run("behavioral conformance", process.execPath, ["--test", "tests/m4/conformance.test.mjs"], ROOT, { test: true });
run("reference package focused tests", "npm", ["test"], PACKAGE_ROOT, { test: true });
const npmCache = mkdtempSync(join(tmpdir(), "agent-feed-m4-npm-cache-"));
try {
  run(
    "reference package artifact smoke check",
    "npm",
    ["pack", "--dry-run"],
    PACKAGE_ROOT,
    { env: { ...process.env, npm_config_cache: npmCache } },
  );
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("\n[M4] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n[M4] all architecture, behavioral, build, package, and artifact gates passed.");
}
