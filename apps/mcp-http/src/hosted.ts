import {
  createAgentFeedPool,
  migrateAgentFeed,
  PostgresAgentFeedPersistence,
} from "@agent-feed/persistence-postgres";
import {
  ProducerService,
  StaticProducerAuthenticator,
  type ProducerPrincipal,
} from "@agent-feed/producer-service";
import {
  authorizationFromEnvironment,
  credentialsFromEnvironment,
} from "@agent-feed/mcp-server";
import {
  CompositeAccessTokenVerifier,
  ProducerCredentialVerifier,
  type AccessTokenVerifier,
} from "./auth.ts";
import { CHATGPT_ORIGIN, createMcpHttpGateway, type McpHttpGateway } from "./gateway.ts";
import { GitHubActionsOidcVerifier } from "./github-actions-oidc.ts";
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

function hostname(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const normalized = value.includes("://") ? value : `https://${value}`;
    return new URL(normalized).hostname;
  } catch {
    return undefined;
  }
}

function githubActionsVerifier(
  publicUrl: URL,
  principal: ProducerPrincipal,
): AccessTokenVerifier | undefined {
  const repositoryId = process.env.VERCEL_GIT_REPO_ID;
  const repositoryOwner = process.env.VERCEL_GIT_REPO_OWNER;
  const repositorySlug = process.env.VERCEL_GIT_REPO_SLUG;
  const commitRef = process.env.VERCEL_GIT_COMMIT_REF;
  if (
    repositoryId === undefined || repositoryId === "" ||
    repositoryOwner === undefined || repositoryOwner === "" ||
    repositorySlug === undefined || repositorySlug === "" ||
    commitRef === undefined || commitRef === ""
  ) {
    return undefined;
  }
  const repository = `${repositoryOwner}/${repositorySlug}`;
  const ref = `refs/heads/${commitRef}`;
  return new GitHubActionsOidcVerifier({
    resource: publicUrl,
    principal,
    repository,
    repository_id: repositoryId,
    ref,
    workflow_ref: `${repository}/.github/workflows/agent-feed-relay.yml@${ref}`,
  });
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
    const githubOidc = githubActionsVerifier(publicUrl, principal);
    const verifiers: AccessTokenVerifier[] = [
      oauth,
      new ProducerCredentialVerifier(service, publicUrl),
    ];
    if (githubOidc !== undefined) verifiers.push(githubOidc);
    const verifier = new CompositeAccessTokenVerifier(verifiers);
    const deploymentHosts = [
      hostname(process.env.VERCEL_URL),
      hostname(process.env.VERCEL_BRANCH_URL),
      hostname(process.env.VERCEL_PROJECT_PRODUCTION_URL),
    ].filter((value): value is string => value !== undefined);
    const gateway = createMcpHttpGateway({
      public_url: publicUrl,
      service,
      verifier,
      oauth,
      allowed_hosts: [...new Set([
        publicUrl.hostname,
        ...deploymentHosts,
        ...list(process.env.AGENT_FEED_MCP_ALLOWED_HOSTS),
      ])],
      allowed_origins: [...new Set([
        CHATGPT_ORIGIN,
        ...list(process.env.AGENT_FEED_MCP_ALLOWED_ORIGINS),
      ])],
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
