import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;

function run(label, command, args) {
  console.log(`\n[M5] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

try {
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
  console.log("\n[M5] installability architecture, operator, and clean CLI gates passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "M5 conformance failed");
  process.exitCode = 1;
}
