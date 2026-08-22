import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function checkInstallabilityTexts({ compose, configuration, operator, cli, gitignore, envExample, runbook, packageJson, workflow, runner }) {
  const failures = [];
  const requireText = (text, marker, label) => {
    if (!text.includes(marker)) failures.push(`${label} missing ${marker}`);
  };
  requireText(compose, "postgres:16-alpine", "compose");
  requireText(compose, "127.0.0.1:${AGENT_FEED_POSTGRES_PORT}:5432", "compose");
  requireText(compose, "agent_feed_postgres", "compose");
  if (/0\.0\.0\.0|--volumes|volume[\s_-]*rm/iu.test(compose)) failures.push("compose exposes or destructively removes PostgreSQL state");
  requireText(operator, "createMcpEnvironment", "operator");
  requireText(operator, "AGENT_FEED_MCP_PRODUCER_SECRET", "operator");
  requireText(operator, "SAFE_CHILD_ENV_NAMES", "operator");
  requireText(operator, "const env = {}", "operator");
  requireText(operator, "stdio: \"inherit\"", "operator");
  requireText(operator, "mode: 0o700", "operator");
  requireText(operator, "--require-control-plane-poll", "operator");
  requireText(operator, "tunnelHealthResultOk", "operator");
  requireText(configuration, "validateDatabaseUrl", "operator configuration");
  requireText(configuration, "generateSecret", "operator configuration");
  requireText(configuration, "renderMcpWrapper", "operator configuration");
  const operatorBoundary = `${configuration}\n${operator}`;
  if (/CONTROL_PLANE_API_KEY|tunnel_[A-Za-z0-9]{12,}/u.test(operatorBoundary)) failures.push("operator must not own OpenAI tunnel credentials or identities");
  if (/\beval\b|npm\s+(?:run\s+)?start/iu.test(operatorBoundary)) failures.push("operator uses an unsafe shell or package-manager MCP launch path");
  requireText(cli, "runCli", "root CLI");
  requireText(gitignore, ".runtime/", "gitignore");
  for (const marker of ["AGENT_FEED_DATABASE_URL", "AGENT_FEED_TENANT_ID", "AGENT_FEED_PRODUCER_ID", "AGENT_FEED_ALLOWED_STREAMS", "AGENT_FEED_PRODUCER_SECRET"]) {
    requireText(envExample, marker, "environment example");
  }
  for (const line of envExample.split("\n")) {
    const match = /^(?<name>[A-Z0-9_]*(?:SECRET|PASSWORD|KEY|TOKEN))=(?<value>.*)$/u.exec(line);
    if (!match?.groups?.value) continue;
    if (!/(?:replace|example|change[-_]?me|placeholder)/iu.test(match.groups.value)) {
      failures.push(`environment example appears to contain a real secret in ${match.groups.name}`);
    }
  }
  for (const marker of ["bin/agent-feed setup", "bin/agent-feed doctor", "--tunnel-url-file", "explicit account-side", "never prints secrets"]) {
    requireText(runbook, marker, "GitHub installation runbook");
  }
  if (!packageJson.scripts?.["m5:conformance"]) failures.push("root package is missing m5:conformance");
  for (const marker of ["milestone-5-installability", "npm --prefix apps/mcp-server ci", "npm run m5:conformance"]) {
    requireText(workflow, marker, "CI workflow");
  }
  for (const marker of ["architecture.test.mjs", "operator.test.mjs", "clean CLI setup smoke", "clean CLI doctor smoke"]) {
    requireText(runner, marker, "M5 runner");
  }
  return failures;
}

export function checkM5Architecture(root = ROOT) {
  const read = (relative) => readFileSync(path.join(root, relative), "utf8");
  const failures = checkInstallabilityTexts({
    compose: read("compose.yaml"),
    configuration: read("apps/operator-cli/src/config.mjs"),
    operator: read("apps/operator-cli/src/operator.mjs"),
    cli: read("bin/agent-feed"),
    gitignore: read(".gitignore"),
    envExample: read(".env.example"),
    runbook: read("docs/operations/github-installation.md"),
    packageJson: JSON.parse(read("package.json")),
    workflow: read(".github/workflows/ci.yml"),
    runner: read("scripts/run_m5_conformance.mjs"),
  });
  if (process.platform !== "win32" && (statSync(path.join(root, "bin", "agent-feed")).mode & 0o111) === 0) {
    failures.push("root CLI is not executable in a GitHub checkout");
  }
  if (failures.length) throw new Error(`M5 installability architecture failed:\n- ${failures.join("\n- ")}`);
  return 8;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = checkM5Architecture();
    console.log(`M5 installability architecture checks passed (${count} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M5 installability architecture failed");
    process.exitCode = 1;
  }
}
