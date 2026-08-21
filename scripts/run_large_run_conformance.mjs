import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const unitOnly = process.argv.includes("--unit-only");
const failures = [];

function run(label, command, args, cwd = ROOT) {
  console.log(`\n[large-run] ${label}`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}

run("TypeScript SDK clean build and tests", NPM, ["run", "verify"], path.join(ROOT, "packages/sdk/typescript"));
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);

if (databaseUrl) {
  run("live PostgreSQL 250-unit ingestion and exact retry", NODE, [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    "tests/large-run/postgres-conformance.test.ts",
  ]);
} else if (!unitOnly) {
  failures.push("live PostgreSQL large-run proof: AGENT_FEED_DATABASE_URL is required");
  console.error("\n[large-run] LIVE POSTGRES: AGENT_FEED_DATABASE_URL is required");
} else {
  console.log("\n[large-run] live PostgreSQL explicitly omitted by --unit-only; this is not durability evidence");
}

if (failures.length > 0) {
  console.error("\n[large-run] CONFORMANCE FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n[large-run] bounded planning, sequential submission, durable ingestion, and exact retry passed");
}
