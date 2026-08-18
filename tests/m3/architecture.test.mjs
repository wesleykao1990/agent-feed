import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkM3Architecture } from "../../scripts/check_m3_architecture.mjs";

const BOUNDARIES = [
  ["apps/mcp-server", "typescript"],
  ["packages/sdk/typescript", "typescript"],
  ["packages/sdk/python", "python"],
  ["packages/adapters/rest", "typescript"],
  ["packages/adapters/local-file", "typescript"],
  ["packages/adapters/generic-webhook", "typescript"],
  ["packages/adapters/claude-hook", "typescript"],
  ["packages/adapters/chatgpt-manual-export", "typescript"],
];

async function put(root, pathname, contents) {
  const target = join(root, pathname);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents, "utf8");
}

function packageJson(name, dependencies = {}) {
  return JSON.stringify({
    name,
    version: "0.1.1",
    type: "module",
    scripts: { build: "true", test: "true" },
    dependencies,
  });
}

async function validFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m3-architecture-"));
  for (const [pathname, kind] of BOUNDARIES) {
    if (kind === "typescript") {
      const mcp = pathname === "apps/mcp-server";
      await put(root, `${pathname}/package.json`, packageJson(
        `fixture-${pathname.replaceAll("/", "-")}`,
        mcp ? { "@modelcontextprotocol/server": "2.0.0" } : {},
      ));
      await put(root, `${pathname}/src/index.ts`, `
        import { ProducerService } from "@agent-feed/producer-service";
        ${mcp ? 'import { Server } from "@modelcontextprotocol/server"; import { serveStdio } from "@modelcontextprotocol/server/stdio"; void Server; void serveStdio;' : ""}
        export const PROTOCOL_VERSION = "0.1";
        export async function beginRun() { return ProducerService; }
        export async function submitBatch() { return null; }
        export async function completeRun() { return { status: "partial" }; }
        export async function pull() { return null; }
        export async function acknowledge() { return null; }
        export async function replay() { return null; }
      `);
      if (mcp) {
        await put(root, `${pathname}/src/main.ts`, `
          import { serveStdio } from "@modelcontextprotocol/server/stdio";
          import { createOfficialMcpServer } from "./sdk.ts";
          serveStdio(() => createOfficialMcpServer());
        `);
      }
    } else {
      await put(root, `${pathname}/agent_feed/client.py`, `
        PROTOCOL_VERSION = "0.1"
        def begin_run(value): return value
        def submit_batch(value): return value
        def complete_run(value): return value
        def pull(value): return value
        def acknowledge(value): return value
        def replay(value): return value
        class ProducerClient: pass
        class ConsumerClient: pass
      `);
    }
  }
  await put(root, "apps/api/src/index.ts", `import { ProducerService } from "@agent-feed/producer-service"; export { ProducerService };`);
  await put(root, "skills/chatgpt/SKILL.md", "Capability-gated direct tools; otherwise produce a protocol run-bundle for local-file import.");
  return root;
}

test("the repository M3 architecture gate is fail-closed and reports no acceptance skips", () => {
  const result = checkM3Architecture();
  assert.equal(Array.isArray(result.missing), true);
  assert.equal(Object.hasOwn(result, "skipped"), false);
  // This assertion turns green only after all M3 implementation packages are
  // present.  A README placeholder is intentionally an acceptance failure.
  assert.equal(result.ok, true, result.violations.join("\n"));
});

test("the architecture gate accepts complete transport-injected boundaries", async () => {
  const root = await validFixture();
  await put(root, "packages/sdk/typescript/src/types.ts", `
    /** A consumer may legitimately expose points as untrusted source text. */
    export interface ObservationText { points: readonly string[]; reward_notes?: string; }
  `);
  const result = checkM3Architecture({ root });
  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.deepEqual(result.missing, []);
});

test("the architecture gate rejects database, SQL, server-internal, source-subpath, and raw-log leaks", async () => {
  const root = await validFixture();
  await put(root, "packages/sdk/python/pyproject.toml", `[project]\ndependencies = ["psycopg>=3"]\n`);
  await put(root, "packages/sdk/typescript/src/leak.ts", `
    import pg from "pg";
    import { app } from "@agent-feed/api/src/index.ts";
    const rows = "select * from agent_feed.runs";
    console.error(error);
    export { pg, app, rows };
  `);
  const result = checkM3Architecture({ root });
  assert.equal(result.ok, false);
  const report = result.violations.join("\n");
  assert.match(report, /database implementation\/driver/iu);
  assert.match(report, /private \/src subpath/iu);
  assert.match(report, /SQL/iu);
  assert.match(report, /raw errors/iu);
  assert.match(report, /database dependency psycopg/iu);
});

test("the MCP executable composition root may own Postgres, but handlers may not", async () => {
  const root = await validFixture();
  await put(root, "apps/mcp-server/package.json", packageJson("fixture-mcp", {
    "@agent-feed/persistence-postgres": "file:../../packages/persistence-postgres",
    "@modelcontextprotocol/server": "2.0.0",
  }));
  let result = checkM3Architecture({ root });
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /database dependency/iu);

  await put(root, "apps/mcp-server/src/main.ts", `
    import { PostgresAgentFeedPersistence } from "@agent-feed/persistence-postgres";
    import { serveStdio } from "@modelcontextprotocol/server/stdio";
    import { createOfficialMcpServer } from "./sdk.ts";
    void PostgresAgentFeedPersistence;
    serveStdio(() => createOfficialMcpServer());
  `);
  result = checkM3Architecture({ root });
  assert.equal(result.ok, true, result.violations.join("\n"));

  await put(root, "apps/mcp-server/src/tools.ts", `import { PostgresAgentFeedPersistence } from "@agent-feed/persistence-postgres"; void PostgresAgentFeedPersistence;`);
  result = checkM3Architecture({ root });
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /database implementation\/driver/iu);

  await put(root, "apps/mcp-server/src/tools.ts", `export const tools = [];`);
  await put(root, "apps/mcp-server/src/main.ts", `
    import { PostgresAgentFeedPersistence } from "@agent-feed/persistence-postgres";
    import { serveStdio } from "@modelcontextprotocol/server/stdio";
    import { AgentFeedMcpServer } from "./server.ts";
    void PostgresAgentFeedPersistence;
    serveStdio(() => new AgentFeedMcpServer());
  `);
  result = checkM3Architecture({ root });
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /official SDK server|internal legacy facade/iu);
});
