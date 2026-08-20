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
  console.log(`\n[M9] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}
run("job-registry architecture guard", NODE, ["scripts/check_m9_architecture.mjs"]);
run("job-registry core build", NPM, ["--prefix", "packages/job-registry-core", "run", "build"]);
run("job-registry core tests", NPM, ["--prefix", "packages/job-registry-core", "test"]);
run("PostgreSQL persistence build", NPM, ["--prefix", "packages/persistence-postgres", "run", "build"]);
run("PostgreSQL registry tests", NPM, ["--prefix", "packages/persistence-postgres", "test"], databaseUrl ? { AGENT_FEED_DATABASE_URL: databaseUrl } : {});
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);
if (!unitOnly && !databaseUrl) failures.push("live PostgreSQL job registry: AGENT_FEED_DATABASE_URL is required");
if (failures.length > 0) {
  console.error("\n[M9] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (unitOnly) console.log("\n[M9] job-registry unit gate passed; no live PostgreSQL acceptance is claimed.");
else console.log("\n[M9] portable job-registry gate passed, including live PostgreSQL acceptance.");
