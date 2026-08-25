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
  ProducerCredentialVerifier,
} from "./auth.ts";
import { createMcpHttpGateway, type McpHttpGateway } from "./gateway.ts";
import { PersistentOAuthProvider } from "./persistent-auth.ts";
import { ensureMcpOAuthState, PostgresOAuthStateStore } from "./oauth-store.ts";

interface HostedRuntime {
  gateway: McpHttpGateway;
}

let runtimePromise: Promise<HostedRuntime> | undefined;

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("invalid_positive_integer_configuration");
  return result;
}

function boundedDiagnostic(error: unknown): { error_name: string; error_code: string | null; error_message: string | null } {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    error_name: typeof value?.name === "string" ? value.name : "Error",
    error_code: typeof value?.code === "string" ? value.code : null,
    error_message: typeof value?.message === "string" ? value.message.slice(0, 500) : null,
  };
}

async function createHostedRuntime(): Promise<HostedRuntime> {
  const publicUrlValue = process.env.AGENT_FEED_MCP_PUBLIC_URL;
  if (publicUrlValue === undefined || publicUrlValue === "") throw new Error("agent_feed_mcp_public_url_required");
  const publicUrl = new URL(publicUrlValue);
  if (publicUrl.pathname !== "/mcp") throw new Error("agent_feed_mcp_public_url_must_end_in_mcp");
  const operatorSecret = process.env.AGENT_FEED_MCP_OAUTH_OPERATOR_SECRET;
  if (operatorSecret === undefined || operatorSecret === "") throw new Error("agent_feed_mcp_oauth_operator_secret_required");

  const pool = createAgentFeedPool();
  try {
    await migrateAgentFeed(pool);
    await ensureMcpOAuthState(pool);
    const credentials = credentialsFromEnvironment(process.env);
    const service = new ProducerService({
      persistence: new PostgresAgentFeedPersistence(pool),
      authenticator: new StaticProducerAuthenticator(credentials),
    });
    const principal = service.authenticate({ authorization: authorizationFromEnvironment(credentials, process.env) });
    const oauth = new PersistentOAuthProvider({
      issuer: publicUrl,
      resource: publicUrl,
      operator_secret: operatorSecret,
      principal,
      store: new PostgresOAuthStateStore(pool),
    });
    const verifier = new CompositeAccessTokenVerifier([
      oauth,
      new ProducerCredentialVerifier(service, publicUrl),
    ]);
    const gateway = createMcpHttpGateway({
      public_url: publicUrl,
      service,
      verifier,
      oauth,
      allowed_hosts: [...new Set([
        publicUrl.hostname,
        ...list(process.env.AGENT_FEED_MCP_ALLOWED_HOSTS),
      ])],
      allowed_origins: list(process.env.AGENT_FEED_MCP_ALLOWED_ORIGINS),
      max_body_bytes: positiveInteger(process.env.AGENT_FEED_MCP_MAX_BODY_BYTES, service.security.max_body_bytes),
      enable_bounded_run: true,
      on_error: () => undefined,
    });
    return { gateway };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function hostedAgentFeedFetch(request: Request): Promise<Response> {
  runtimePromise ??= createHostedRuntime().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  try {
    return await (await runtimePromise).gateway.fetch(request);
  } catch (error) {
    if (new URL(request.url).pathname === "/health") {
      return Response.json(
        { ok: false, stage: "hosted_runtime_initialization", ...boundedDiagnostic(error) },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return new Response("Agent Feed MCP unavailable", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
}

/** Test-only reset for simulating a serverless cold start. */
export function resetHostedAgentFeedRuntimeForTest(): void {
  runtimePromise = undefined;
}
