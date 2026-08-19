import {
  createAgentFeedPool,
  migrateAgentFeed,
  PostgresAgentFeedPersistence,
} from "@agent-feed/persistence-postgres";
import {
  ProducerService,
  StaticProducerAuthenticator,
} from "@agent-feed/producer-service";
import {
  authorizationFromEnvironment,
  credentialsFromEnvironment,
} from "@agent-feed/mcp-server";
import {
  CompositeAccessTokenVerifier,
  PilotOAuthProvider,
  ProducerCredentialVerifier,
  createMcpHttpGateway,
  createNodeGatewayServer,
} from "./index.ts";

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("invalid_positive_integer_configuration");
  return result;
}

async function main(): Promise<void> {
  const publicUrl = new URL(process.env.AGENT_FEED_MCP_PUBLIC_URL ?? "http://127.0.0.1:7080/mcp");
  if (publicUrl.pathname !== "/mcp") throw new Error("AGENT_FEED_MCP_PUBLIC_URL must end in /mcp");
  const host = process.env.HOST ?? "127.0.0.1";
  const port = positiveInteger(process.env.PORT, 7080);
  const pool = createAgentFeedPool();
  let gateway: ReturnType<typeof createMcpHttpGateway> | undefined;
  let server: ReturnType<typeof createNodeGatewayServer> | undefined;
  try {
    await migrateAgentFeed(pool);
    const credentials = credentialsFromEnvironment(process.env);
    const service = new ProducerService({
      persistence: new PostgresAgentFeedPersistence(pool),
      authenticator: new StaticProducerAuthenticator(credentials),
    });
    const credentialVerifier = new ProducerCredentialVerifier(service, publicUrl);
    const operatorSecret = process.env.AGENT_FEED_MCP_OAUTH_OPERATOR_SECRET;
    let oauth: PilotOAuthProvider | undefined;
    if (operatorSecret !== undefined && operatorSecret !== "") {
      const principal = service.authenticate({ authorization: authorizationFromEnvironment(credentials, process.env) });
      oauth = new PilotOAuthProvider({
        issuer: publicUrl,
        resource: publicUrl,
        operator_secret: operatorSecret,
        principal,
      });
    }
    const verifier = oauth === undefined
      ? credentialVerifier
      : new CompositeAccessTokenVerifier([oauth, credentialVerifier]);
    gateway = createMcpHttpGateway({
      public_url: publicUrl,
      service,
      verifier,
      ...(oauth === undefined ? {} : { oauth }),
      allowed_hosts: [...new Set([publicUrl.hostname, "127.0.0.1", "localhost", "[::1]", ...list(process.env.AGENT_FEED_MCP_ALLOWED_HOSTS)])],
      allowed_origins: list(process.env.AGENT_FEED_MCP_ALLOWED_ORIGINS),
      max_body_bytes: positiveInteger(process.env.AGENT_FEED_MCP_MAX_BODY_BYTES, service.security.max_body_bytes),
      on_error: (error) => console.error(`Agent Feed MCP request error: ${error.message}`),
    });
    server = createNodeGatewayServer({
      gateway,
      request_origin: new URL(`http://${host}:${port}`),
      on_error: (error) => console.error(`Agent Feed MCP transport error: ${error.message}`),
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, host, () => resolve());
    });
    console.log(`Agent Feed MCP gateway listening on http://${host}:${port}/mcp`);
    console.log(`Public MCP resource: ${publicUrl.href}`);
    console.log(`Pilot OAuth: ${oauth === undefined ? "disabled" : "enabled"}`);
    const shutdown = async () => {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      await gateway!.close();
      await pool.end();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (gateway !== undefined) await gateway.close();
    await pool.end();
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
