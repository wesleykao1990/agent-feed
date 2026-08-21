import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];
function run(label, command, args) {
  console.log(`\n[M12] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
  if (result.error) failures.push(`${label}: ${result.error.message}`); else if (result.status !== 0) failures.push(`${label}: exited ${String(result.status)}`);
}
run("utility-feedback architecture guard", NODE, ["scripts/check_m12_architecture.mjs"]);
run("utility-feedback core build", NPM, ["--prefix", "packages/utility-feedback-core", "run", "build"]);
run("utility-feedback core tests", NPM, ["--prefix", "packages/utility-feedback-core", "test"]);
run("utility-feedback service build", NPM, ["--prefix", "packages/utility-feedback-service", "run", "build"]);
run("utility-feedback service tests", NPM, ["--prefix", "packages/utility-feedback-service", "test"]);
run("PostgreSQL persistence build", NPM, ["--prefix", "packages/persistence-postgres", "run", "build"]);
if (process.env.AGENT_FEED_DATABASE_URL) {
  run("live PostgreSQL utility-feedback tests", NODE, ["--experimental-strip-types", "--test", "packages/persistence-postgres/test/utility-feedback.test.ts"]);
} else console.log("\n[M12] live PostgreSQL utility-feedback tests skipped: AGENT_FEED_DATABASE_URL is not set");
run("protocol compatibility", NPM, ["run", "protocol:compatibility"]);
if (failures.length) { console.error("\n[M12] CONFORMANCE FAILED"); for (const failure of failures) console.error(`- ${failure}`); process.exitCode = 1; }
else console.log("\n[M12] consumer-owned utility-feedback persistence and trusted-service checkpoint passed; aggregate projection, live consumers, and recommendation application are not claimed.");
