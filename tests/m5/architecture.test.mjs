import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkInstallabilityTexts, checkM5Architecture } from "../../scripts/check_m5_architecture.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function currentTexts() {
  const read = (relative) => readFile(path.join(ROOT, relative), "utf8");
  return {
    compose: await read("compose.yaml"),
    configuration: await read("apps/operator-cli/src/config.mjs"),
    operator: await read("apps/operator-cli/src/operator.mjs"),
    cli: await read("bin/agent-feed"),
    gitignore: await read(".gitignore"),
    envExample: await read(".env.example"),
    runbook: await read("docs/operations/github-installation.md"),
    packageJson: JSON.parse(await read("package.json")),
    workflow: await read(".github/workflows/ci.yml"),
    runner: await read("scripts/run_m5_conformance.mjs"),
  };
}

test("the repository passes the fail-closed installability architecture gate", () => {
  assert.equal(checkM5Architecture(ROOT), 8);
});

test("the architecture gate requires clean-checkout CI and both CLI smokes", async () => {
  const fixture = await currentTexts();
  fixture.workflow = "name: incomplete\n";
  fixture.runner = "architecture.test.mjs\n";
  const failures = checkInstallabilityTexts(fixture);
  assert.equal(failures.some((failure) => failure.includes("milestone-5-installability")), true);
  assert.equal(failures.some((failure) => failure.includes("clean CLI doctor smoke")), true);
});

test("the architecture gate rejects public or destructive PostgreSQL composition", async () => {
  const fixture = await currentTexts();
  fixture.compose = fixture.compose.replace("127.0.0.1", "0.0.0.0").replace("stop", "down --volumes");
  const failures = checkInstallabilityTexts(fixture);
  assert.equal(failures.some((failure) => failure.includes("destructively")), true);
});

test("the architecture gate rejects unsafe MCP launchers and tunnel credential ownership", async () => {
  const fixture = await currentTexts();
  fixture.configuration += "\nconst CONTROL_PLANE_API_KEY = 'owned-here';\n// npm start\n";
  const failures = checkInstallabilityTexts(fixture);
  assert.equal(failures.some((failure) => failure.includes("tunnel credentials")), true);
  assert.equal(failures.some((failure) => failure.includes("package-manager")), true);
});

test("the architecture gate requires complete runtime and operator documentation", async () => {
  const fixture = await currentTexts();
  fixture.envExample = "DATABASE_URL=\n";
  fixture.runbook = "incomplete\n";
  const failures = checkInstallabilityTexts(fixture);
  assert.equal(failures.some((failure) => failure.includes("AGENT_FEED_TENANT_ID")), true);
  assert.equal(failures.some((failure) => failure.includes("bin/agent-feed doctor")), true);
});

test("the architecture gate distinguishes placeholders from real-looking sample secrets", async () => {
  const fixture = await currentTexts();
  assert.equal(checkInstallabilityTexts(fixture).some((failure) => failure.includes("real secret")), false);
  fixture.envExample = fixture.envExample.replace(
    "AGENT_FEED_PRODUCER_SECRET=replace-with-a-local-secret-of-at-least-32-characters",
    "AGENT_FEED_PRODUCER_SECRET=abcDEF0123456789abcDEF0123456789",
  );
  assert.equal(checkInstallabilityTexts(fixture).some((failure) => failure.includes("AGENT_FEED_PRODUCER_SECRET")), true);
});
