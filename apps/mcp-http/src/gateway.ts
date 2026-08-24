import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import {
  createOfficialRemoteMcpServer,
  type ProducerServiceBoundary,
} from "@agent-feed/mcp-server";
import {
  MCP_WRITE_SCOPE,
  PilotOAuthProvider,
  principalFromAuthInfo,
  type AccessTokenVerifier,
} from "./auth.ts";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface McpHttpGatewayOptions {
  public_url: URL;
  service: ProducerServiceBoundary;
  verifier: AccessTokenVerifier;
  oauth?: PilotOAuthProvider;
  allowed_hosts?: readonly string[];
  allowed_origins?: readonly string[];
  max_body_bytes?: number;
  on_error?: (error: Error) => void;
}

export interface McpHttpGateway {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  max_body_bytes: number;
}

function safeError(value: unknown): Error {
  return value instanceof Error ? new Error(value.name) : new Error("gateway_error");
}

function hostnameFromHeader(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function corsHeaders(origin: string | null, allowedOrigins: ReadonlySet<string>): HeadersInit {
  if (origin === null || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
    vary: "Origin",
  };
}

function withHeaders(response: Response, headers: HeadersInit): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of new Headers(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function boundedBody(request: Request, maximum: number): Response | undefined {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return undefined;
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return new Response("Invalid Content-Length", { status: 400 });
  return parsed > maximum ? new Response("Request body too large", { status: 413 }) : undefined;
}

/**
 * Transport composition only: auth produces a trusted principal and the
 * remote MCP server remains the sole lifecycle tool definition for HTTP.
 */
export function createMcpHttpGateway(options: McpHttpGatewayOptions): McpHttpGateway {
  if (options.public_url.protocol !== "https:"
    && options.public_url.hostname !== "127.0.0.1"
    && options.public_url.hostname !== "localhost") {
    throw new Error("https_public_url_required");
  }
  if (options.public_url.pathname !== "/mcp") throw new Error("public_url_must_end_in_mcp");
  const maximum = options.max_body_bytes ?? options.service.security?.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1_024) throw new Error("invalid_max_body_bytes");
  const allowedHosts = new Set(options.allowed_hosts ?? [options.public_url.hostname, "127.0.0.1", "localhost", "[::1]"]);
  const allowedOrigins = new Set(options.allowed_origins ?? []);
  const protectedResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(options.public_url);
  const gate = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: [MCP_WRITE_SCOPE],
    resourceMetadataUrl: protectedResourceMetadataUrl,
  });
  const handler = createMcpHandler(
    (context) => createOfficialRemoteMcpServer({
      service: options.service,
      principal: principalFromAuthInfo(context.authInfo),
      max_argument_bytes: maximum,
    }),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => options.on_error?.(safeError(error)),
    },
  );

  async function fetch(request: Request): Promise<Response> {
    const host = hostnameFromHeader(request.headers.get("host"));
    if (host === undefined || !allowedHosts.has(host)) return new Response("Invalid Host", { status: 421 });
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) return new Response("Invalid Origin", { status: 403 });
    const cors = corsHeaders(origin, allowedOrigins);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const tooLarge = boundedBody(request, maximum);
    if (tooLarge !== undefined) return withHeaders(tooLarge, cors);

    if (options.oauth !== undefined) {
      const oauthResponse = await options.oauth.route(request);
      if (oauthResponse !== undefined) return withHeaders(oauthResponse, cors);
      const metadataResponse = oauthMetadataResponse(request, {
        oauthMetadata: options.oauth.metadata() as OAuthMetadata,
        resourceServerUrl: options.public_url,
        scopesSupported: [MCP_WRITE_SCOPE],
        resourceName: "Agent Feed producer ingress",
      });
      if (metadataResponse !== undefined) return withHeaders(metadataResponse, cors);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return withHeaders(new Response(JSON.stringify({ status: "ok" }), {
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      }), cors);
    }
    if (url.pathname !== "/mcp") return withHeaders(new Response("Not found", { status: 404 }), cors);
    const auth: AuthInfo | Response = await gate(request);
    if (auth instanceof Response) return withHeaders(auth, cors);
    return withHeaders(await handler.fetch(request, { authInfo: auth }), cors);
  }

  return { fetch, close: () => handler.close(), max_body_bytes: maximum };
}
