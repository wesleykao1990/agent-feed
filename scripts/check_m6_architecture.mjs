import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

export function checkM6Texts(input) {
  const failures = [];
  const requireText = (source, marker, label) => {
    if (!source.includes(marker)) failures.push(`${label} missing ${marker}`);
  };
  for (const marker of ["createOfficialMcpServer", "principalFromAuthInfo", "requireBearerAuth", "createMcpHandler"]) {
    requireText(input.gateway, marker, "gateway");
  }
  for (const marker of ["StaticProducerAuthenticator", "PostgresAgentFeedPersistence", "migrateAgentFeed", "AGENT_FEED_MCP_PUBLIC_URL"]) {
    requireText(input.main, marker, "composition root");
  }
  for (const marker of ["code_challenge", "S256", "timingSafeEqual", "expires_at", "memory-only"]) {
    requireText(input.auth, marker, "OAuth boundary");
  }
  for (const marker of ["readBody", "request_body_too_large", "127.0.0.1"]) {
    requireText(`${input.nodeServer}\n${input.main}`, marker, "Node transport");
  }
  for (const marker of ["@agent-feed/mcp-server", "@agent-feed/producer-service", "@agent-feed/persistence-postgres", "@modelcontextprotocol/server"]) {
    if (!input.packageJson.dependencies?.[marker]) failures.push(`HTTP package missing dependency ${marker}`);
  }
  if (input.packageJson.dependencies?.["@modelcontextprotocol/server"] !== "2.0.0") failures.push("official MCP server dependency must be exact-pinned");
  if (/class\s+(?:ProducerService|LifecycleToolRouter)|function\s+(?:beginRun|submitBatch|completeRun)/u.test(input.gateway)) {
    failures.push("gateway duplicates producer lifecycle policy");
  }
  if (/authorization|secret|token/iu.test(input.tools)) failures.push("published MCP tool schemas must not gain credential fields");
  if (!input.rootPackage.scripts?.["m6:conformance"]) failures.push("root package missing m6:conformance");
  for (const marker of ["apps/mcp-http ci", "npm run m6:conformance"]) requireText(input.workflow, marker, "CI workflow");
  for (const marker of ["single-process pilot", "durable OAuth", "not production acceptance"]) requireText(input.milestone, marker, "M6 record");
  return failures;
}

export function checkM6Architecture() {
  const failures = checkM6Texts({
    gateway: read("apps/mcp-http/src/gateway.ts"),
    main: read("apps/mcp-http/src/main.ts"),
    auth: read("apps/mcp-http/src/auth.ts"),
    nodeServer: read("apps/mcp-http/src/node-server.ts"),
    tools: read("apps/mcp-server/src/tools.ts"),
    packageJson: JSON.parse(read("apps/mcp-http/package.json")),
    rootPackage: JSON.parse(read("package.json")),
    workflow: read(".github/workflows/ci.yml"),
    milestone: read("docs/17_milestone_6_universal_remote_mcp.md"),
  });
  if (failures.length > 0) throw new Error(`M6 remote MCP architecture failed:\n- ${failures.join("\n- ")}`);
  return 8;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = checkM6Architecture();
    console.log(`M6 remote MCP architecture checks passed (${count} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M6 remote MCP architecture failed");
    process.exitCode = 1;
  }
}
