import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const installabilityOnly = process.argv.includes("--installability-only");
const databaseUrl = process.env.AGENT_FEED_OPERATIONS_DATABASE_URL ?? process.env.AGENT_FEED_DATABASE_URL;
const failures = [];

function run(label, command, args, options = {}) {
  console.log(`\n[M5] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
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

run("installability architecture guard", NODE, ["scripts/check_m5_architecture.mjs"]);
run("architecture adversarial tests", NODE, ["--test", "tests/m5/architecture.test.mjs"]);
run("operator CLI tests", NODE, ["--test", "apps/operator-cli/test/operator.test.mjs"]);
run("operator CLI help smoke", NODE, ["bin/agent-feed", "--help"]);
const runtime = mkdtempSync(path.join(os.tmpdir(), "agent-feed-m5-cli-"));
try {
  run("clean CLI setup smoke", NODE, ["bin/agent-feed", "setup", "--runtime-dir", runtime, "--stream", "monitoring.ci", "--skip-install"]);
  run("clean CLI doctor smoke", NODE, ["bin/agent-feed", "doctor", "--config", path.join(runtime, "config.json"), "--offline"]);
} finally {
  rmSync(runtime, { recursive: true, force: true });
}

if (!installabilityOnly) {
  run("portability and operations architecture guard", NODE, ["scripts/check_m5_operations_architecture.mjs"]);
  run("portability and operations adversarial tests", NODE, ["--test", "tests/m5/portability-operations.test.mjs"]);
  run("SQLite portability reference", NPM, ["--prefix", "examples/sqlite", "run", "verify"]);
  run("Supabase reference static verification", NODE, ["examples/supabase/tests/verify.mjs"]);

  if (databaseUrl) {
    run("explicit PostgreSQL migration chain", NODE, ["--experimental-strip-types", "scripts/prepare_m5_database.mjs"], {
      env: { AGENT_FEED_OPERATIONS_DATABASE_URL: databaseUrl },
    });
  }

  for (const relativePackage of [
    "packages/operations-core",
    "packages/operations-observability",
    "packages/operations-postgres",
    "apps/admin-dashboard",
  ]) {
    run(`${relativePackage} build`, NPM, ["--prefix", relativePackage, "run", "build"]);
    run(`${relativePackage} tests`, NPM, ["--prefix", relativePackage, "test"], {
      env: databaseUrl ? { AGENT_FEED_OPERATIONS_DATABASE_URL: databaseUrl } : {},
    });
  }

  if (databaseUrl) {
    run("Supabase PostgreSQL-compatible migration proof", NODE, ["--experimental-strip-types", "examples/supabase/tests/postgres.mjs"], {
      env: { AGENT_FEED_OPERATIONS_DATABASE_URL: databaseUrl },
    });
  } else {
    failures.push("live PostgreSQL operations and Supabase proof: AGENT_FEED_OPERATIONS_DATABASE_URL or AGENT_FEED_DATABASE_URL is required");
  }
}

if (failures.length > 0) {
  console.error("\n[M5] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (installabilityOnly) {
  console.log("\n[M5] Milestone 5A installability gate passed.");
} else {
  console.log("\n[M5] full portability and operations gate passed, including live PostgreSQL proof.");
}
