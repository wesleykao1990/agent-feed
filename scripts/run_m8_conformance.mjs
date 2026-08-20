import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const unitOnly = process.argv.includes("--unit-only");
const failures = [];

function run(label, command, args, options = {}) {
  console.log(`\n[M8] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
  });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}

run("job-proof architecture guard", NODE, ["scripts/check_m8_architecture.mjs"]);
run("assessment-core build", NPM, ["--prefix", "packages/assessment-core", "run", "build"]);
run("assessment-core tests", NPM, ["--prefix", "packages/assessment-core", "test"]);
run("PostgreSQL persistence build", NPM, ["--prefix", "packages/persistence-postgres", "run", "build"]);
run("PostgreSQL job-proof tests", NPM, ["--prefix", "packages/persistence-postgres", "test"], databaseUrl ? {
  env: { AGENT_FEED_DATABASE_URL: databaseUrl },
} : {});
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);

if (!unitOnly && !databaseUrl) failures.push("live PostgreSQL job proof: AGENT_FEED_DATABASE_URL is required");

if (failures.length > 0) {
  console.error("\n[M8] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (unitOnly) {
  console.log("\n[M8] job-proof unit gate passed; no live PostgreSQL acceptance is claimed.");
} else {
  console.log("\n[M8] independent job-proof gate passed, including live PostgreSQL acceptance.");
}
