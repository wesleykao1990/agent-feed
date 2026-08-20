import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];

function run(label, command, args) {
  console.log(`\n[M11] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
  if (result.error) failures.push(`${label}: ${result.error.message}`);
  else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}

run("provider-conformance architecture guard", NODE, ["scripts/check_m11_architecture.mjs"]);
run("provider-conformance core build", NPM, ["--prefix", "packages/provider-conformance-core", "run", "build"]);
run("five-topology adapter fixture and contract tests", NPM, ["--prefix", "packages/provider-conformance-core", "test"]);
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);

if (failures.length > 0) {
  console.error("\n[M11] CONFORMANCE FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n[M11] provider-neutral contract and five synthetic adapter-topology fixtures passed; no live provider-account or production-hosting acceptance is claimed.");
}
