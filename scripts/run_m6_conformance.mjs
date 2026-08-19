import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = process.env.AGENT_FEED_MCP_DATABASE_URL ?? process.env.AGENT_FEED_DATABASE_URL;
const unitOnly = process.argv.includes("--unit-only");
const failures = [];

function run(label, command, args, options = {}) {
  console.log(`\n[M6] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
  });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}

run("remote MCP architecture guard", NODE, ["scripts/check_m6_architecture.mjs"]);
run("generated schema dependency build", NPM, ["--prefix", "packages/schema", "run", "build"]);
run("remote MCP build", NPM, ["--prefix", "apps/mcp-http", "run", "build"]);
run("remote MCP unit and adversarial tests", NPM, ["--prefix", "apps/mcp-http", "test"], databaseUrl ? {
  env: { AGENT_FEED_MCP_DATABASE_URL: databaseUrl },
} : {});
run("stdio MCP regression", NPM, ["--prefix", "apps/mcp-server", "test"]);

if (!unitOnly && !databaseUrl) failures.push("live PostgreSQL remote MCP proof: AGENT_FEED_MCP_DATABASE_URL or AGENT_FEED_DATABASE_URL is required");

if (failures.length > 0) {
  console.error("\n[M6] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (unitOnly) {
  console.log("\n[M6] remote MCP unit gate passed; live PostgreSQL and Claude receipts remain separate.");
} else {
  console.log("\n[M6] remote MCP gate passed, including the live PostgreSQL acceptance test.");
}
