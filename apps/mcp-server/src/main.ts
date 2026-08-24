import {
  createAgentFeedPool,
  migrateAgentFeed,
  PostgresAgentFeedPersistence,
} from "@agent-feed/persistence-postgres";
import { ProducerService, StaticProducerAuthenticator } from "@agent-feed/producer-service";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { authorizationFromEnvironment, credentialsFromEnvironment } from "./composition.ts";
import { createOfficialRemoteMcpServer } from "./sdk.ts";

/** Production PostgreSQL-backed MCP composition root used by Secure MCP Tunnel. */
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
    // The production tunnel executable exposes the primitive lifecycle tools
    // plus submit_bounded_run so an interactive client cannot be stranded
    // between begin/submit/complete when a conversation turn is interrupted.
    // The lower-level createOfficialMcpServer/serveAgentFeedMcpStdio exports
    // retain the historical three-tool conformance surface for embedders.
    const handle = serveStdio(() => createOfficialRemoteMcpServer(serverOptions), {
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
