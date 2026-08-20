import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const unitOnly = process.argv.includes("--unit-only");
const failures = [];

function run(label, command, args, env = {}) {
  console.log(`\n[M10] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}

run("control-plane architecture guard", NODE, ["scripts/check_m10_architecture.mjs"]);
run("control-plane core build", NPM, ["--prefix", "packages/control-plane-core", "run", "build"]);
run("control-plane core tests", NPM, ["--prefix", "packages/control-plane-core", "test"]);
run("control-plane PostgreSQL adapter build", NPM, ["--prefix", "packages/control-plane-postgres", "run", "build"]);
run("control-plane PostgreSQL adapter tests", NPM, ["--prefix", "packages/control-plane-postgres", "test"], databaseUrl ? { AGENT_FEED_DATABASE_URL: databaseUrl } : {});
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);
if (!unitOnly && !databaseUrl) failures.push("live PostgreSQL control-plane acceptance: AGENT_FEED_DATABASE_URL is required");

if (failures.length > 0) {
  console.error("\n[M10] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (unitOnly) console.log("\n[M10] control-plane unit gate passed; no live PostgreSQL acceptance is claimed.");
else console.log("\n[M10] control-plane contract and live tenant-scoped PostgreSQL gate passed.");
