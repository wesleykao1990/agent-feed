#!/usr/bin/env node

/**
 * Execute the live PostgreSQL/HTTP producer-ingress gate.
 *
 * This command is intentionally fail-closed: a missing database URL is a
 * blocked gate, not a skipped test.  The tests use the public apps/api entry
 * point and the documented /v1 producer routes; they never exercise the
 * in-memory prototype as evidence of durable ingress.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

if (!databaseUrl) {
  console.error("[M1 ingress] BLOCKED — AGENT_FEED_DATABASE_URL is required; live PostgreSQL is not optional");
  process.exit(1);
} else {
  const args = [
    "--experimental-strip-types",
    "--test-concurrency=1",
    "--test",
    ...readdirSync(resolve(ROOT, "tests/ingress"))
      .filter((name) => /\.test\.ts$/u.test(name))
      .sort()
      .map((name) => `tests/ingress/${name}`),
  ];
  console.log(`[M1 ingress] ${NODE} ${args.join(" ")}`);
  const result = spawnSync(NODE, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[M1 ingress] FAILED — ${result.error.message}`);
    process.exit(1);
  } else if (result.status !== 0) {
    console.error(`[M1 ingress] FAILED — test process exited ${String(result.status)}`);
    process.exit(result.status ?? 1);
  } else {
    console.log("[M1 ingress] PASS — live PostgreSQL/HTTP producer ingress conformance passed");
  }
}
