import {
  createAgentFeedPool,
  migrateAgentFeed,
  PostgresAgentFeedPersistence,
} from "@agent-feed/persistence-postgres";
import { ProducerService, StaticProducerAuthenticator } from "@agent-feed/producer-service";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { authorizationFromEnvironment, credentialsFromEnvironment } from "./composition.ts";
import { createOfficialMcpServer } from "./sdk.ts";

/** Production PostgreSQL-backed MCP composition root. */
export async function main(): Promise<void> {
  let pool: ReturnType<typeof createAgentFeedPool> | undefined;
  try {
    const credentials = credentialsFromEnvironment();
    pool = createAgentFeedPool();
    await migrateAgentFeed(pool);
    const service = new ProducerService({
      persistence: new PostgresAgentFeedPersistence(pool),
      authenticator: new StaticProducerAuthenticator(credentials),
    });
    const serverOptions = {
      service,
      authorization: authorizationFromEnvironment(credentials),
    };
    // `serveStdio(factory)` owns the era decision for the connection. A
    // modern client probes `server/discover` and sends per-request `_meta`;
    // older clients use the same factory through `initialize`.
    const handle = serveStdio(() => createOfficialMcpServer(serverOptions), {
      // The MCP wire must remain free of diagnostics and secrets. Startup
      // failures are handled below; SDK transport errors are intentionally
      // observed without writing arbitrary messages to stderr.
      onerror: () => undefined,
    });
    await waitForStdioShutdown();
    await handle.close();
  } catch {
    // Never print configuration, credentials, database URLs, adapter errors,
    // or stack traces to stdout/stderr from an MCP process.
    process.stderr.write("agent-feed-mcp failed to start\n");
    process.exitCode = 1;
  } finally {
    if (pool !== undefined) await pool.end().catch(() => undefined);
  }
}

async function waitForStdioShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
