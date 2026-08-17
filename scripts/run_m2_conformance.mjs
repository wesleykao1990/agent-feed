#!/usr/bin/env node

/**
 * Execute the Milestone 2 acceptance suite as one deterministic gate.
 *
 * The PostgreSQL suite is deliberately not converted into a green result when
 * its URL is absent. CI and the default invocation fail with an explicit
 * "live database required" status. `--allow-live-skip` is only for local
 * package/architecture work while the disposable database is unavailable.
 */

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const allowLiveSkip = process.argv.includes("--allow-live-skip");
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

const failures = [];

function run(label, args, cwd = ROOT) {
  console.log(`\n[M2] ${label}`);
  console.log(`      ${NODE} ${args.join(" ")}`);
  const result = spawnSync(NODE, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    failures.push(`${label}: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    failures.push(`${label}: exited ${String(result.status)}`);
    return false;
  }
  return true;
}

function packageTestFiles(relativePackage) {
  const testDirectory = join(ROOT, relativePackage, "test");
  if (!existsSync(testDirectory)) return [];
  return readdirSync(testDirectory)
    .filter((name) => /\.test\.(?:c|m)?(?:t|j)s$/u.test(name))
    .sort()
    .map((name) => join("test", name));
}

function runPackageTests(relativePackage) {
  const files = packageTestFiles(relativePackage);
  if (files.length === 0) {
    console.log(`\n[M2] ${relativePackage}: no test files found (not a gate)`);
    return;
  }
  // Keep package tests deterministic even when a package script sets a
  // serial test policy. In particular, PostgreSQL tests share one disposable
  // database and concurrent migrations/fixtures can deadlock each other.
  run(`${relativePackage} package tests`, ["--experimental-strip-types", "--test-concurrency=1", "--test", ...files], join(ROOT, relativePackage));
}

run("architecture static guard", ["scripts/check_delivery_architecture.mjs"]);
run("delivery acceptance architecture tests", ["--test", "tests/delivery/architecture.test.mjs"]);
run("delivery pure/application conformance", ["--experimental-strip-types", "--test", "tests/delivery/conformance.test.ts"]);

if (databaseUrl) {
  run("live PostgreSQL delivery conformance", ["--experimental-strip-types", "--test", "tests/delivery/postgres-conformance.test.ts"]);
} else {
  console.error("\n[M2] LIVE POSTGRES: SKIPPED — AGENT_FEED_DATABASE_URL is not set; this is not a passing durability result.");
  if (!allowLiveSkip) failures.push("live PostgreSQL delivery conformance: AGENT_FEED_DATABASE_URL is required");
}

for (const relativePackage of [
  "packages/protocol-runtime",
  "packages/delivery-core",
  "packages/delivery-consumer",
  "packages/persistence-postgres",
  "packages/webhook-adapter",
  "apps/delivery-worker",
  "apps/delivery-api",
]) {
  runPackageTests(relativePackage);
}

if (failures.length > 0) {
  console.error("\n[M2] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (!databaseUrl) {
  console.log("\n[M2] local checks passed; live PostgreSQL remains explicitly skipped (--allow-live-skip).");
} else {
  console.log("\n[M2] all configured conformance gates passed, including live PostgreSQL.");
}
