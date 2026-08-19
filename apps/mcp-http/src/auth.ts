import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type {
  ProducerPrincipal,
} from "@agent-feed/producer-service";
import type { ProducerServiceBoundary } from "@agent-feed/mcp-server";

export const MCP_WRITE_SCOPE = "agent-feed:write" as const;
export const AUTH_PRINCIPAL_KEY = "agent_feed_principal" as const;

interface StoredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  client_id_issued_at: number;
}

interface AuthorizationGrant {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string[];
  resource: string;
  expires_at: number;
  principal: ProducerPrincipal;
}

interface TokenGrant {
  client_id: string;
  scope: string[];
  resource: string;
  expires_at: number;
  principal: ProducerPrincipal;
}

export interface PilotOAuthOptions {
  issuer: URL;
  resource: URL;
  operator_secret: string;
  principal: ProducerPrincipal;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
  authorization_code_ttl_seconds?: number;
  now?: () => number;
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function oauthError(code: string, description: string, status = 400): Response {
  return json({ error: code, error_description: description }, status);
}

function parseScope(value: string | null): string[] {
  if (value === null || value.trim() === "") return [MCP_WRITE_SCOPE];
  const result = [...new Set(value.trim().split(/\s+/u))];
  if (result.some((scope) => scope !== MCP_WRITE_SCOPE)) throw new Error("invalid_scope");
  return result;
}

function redirectAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

function form(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return Promise.reject(new Error("invalid_content_type"));
  }
  return request.text().then((body) => new URLSearchParams(body));
}

function redirectWith(urlValue: string, values: Record<string, string | undefined>): Response {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return Response.redirect(url, 302);
}

function principalFrom(value: unknown): ProducerPrincipal | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.tenant_id !== "string"
    || typeof input.producer_id !== "string"
    || !Array.isArray(input.allowed_stream_ids)
    || !input.allowed_stream_ids.every((stream) => typeof stream === "string")) return undefined;
  return {
    tenant_id: input.tenant_id,
    producer_id: input.producer_id,
    allowed_stream_ids: [...input.allowed_stream_ids] as string[],
    ...(typeof input.credential_id === "string" ? { credential_id: input.credential_id } : {}),
  };
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): ProducerPrincipal {
  const principal = principalFrom(authInfo?.extra?.[AUTH_PRINCIPAL_KEY]);
  if (principal === undefined) throw new Error("authenticated_principal_required");
  return principal;
}

/** Maps existing producer bearer credentials into request-scoped MCP auth. */
export class ProducerCredentialVerifier implements AccessTokenVerifier {
  readonly #service: ProducerServiceBoundary;
  readonly #resource: URL;
  readonly #now: () => number;

  constructor(service: ProducerServiceBoundary, resource: URL, now: () => number = epochSeconds) {
    this.#service = service;
    this.#resource = resource;
    this.#now = now;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const principal = this.#service.authenticate?.({ authorization: `Bearer ${token}`, now_seconds: this.#now() });
      if (principal === undefined) throw new Error("authenticator_unavailable");
      return {
        token,
        clientId: principal.credential_id ?? principal.producer_id,
        scopes: [MCP_WRITE_SCOPE],
        expiresAt: this.#now() + 300,
        resource: this.#resource,
        extra: { [AUTH_PRINCIPAL_KEY]: principal },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
  }
}

/** Tries verifiers in order while returning only one bounded auth failure. */
export class CompositeAccessTokenVerifier implements AccessTokenVerifier {
  readonly verifiers: readonly AccessTokenVerifier[];

  constructor(verifiers: readonly AccessTokenVerifier[]) {
    if (verifiers.length === 0) throw new Error("access_token_verifier_required");
    this.verifiers = verifiers;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    for (const verifier of this.verifiers) {
      try {
        return await verifier.verifyAccessToken(token);
      } catch {
        // Continue without revealing which credential namespace matched.
      }
    }
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
  }
}

/**
 * Small OAuth 2.1 authorization-code + PKCE provider for a single-operator
 * pilot. Grants and tokens are intentionally memory-only and disappear on
 * restart. Production deployments should replace this with a durable IdP.
 */
export class PilotOAuthProvider implements AccessTokenVerifier {
  readonly #issuer: URL;
  readonly #resource: URL;
  readonly #operatorSecret: string;
  readonly #principal: ProducerPrincipal;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #codeTtl: number;
  readonly #now: () => number;
  readonly #clients = new Map<string, StoredClient>();
  readonly #codes = new Map<string, AuthorizationGrant>();
  readonly #accessTokens = new Map<string, TokenGrant>();
  readonly #refreshTokens = new Map<string, TokenGrant>();

  constructor(options: PilotOAuthOptions) {
    if (options.operator_secret.length < 24) throw new Error("oauth_operator_secret_too_short");
    this.#issuer = new URL(options.issuer.origin);
    this.#resource = new URL(options.resource.href);
    this.#operatorSecret = options.operator_secret;
    this.#principal = options.principal;
    this.#accessTtl = options.access_token_ttl_seconds ?? 900;
    this.#refreshTtl = options.refresh_token_ttl_seconds ?? 86_400;
    this.#codeTtl = options.authorization_code_ttl_seconds ?? 180;
    this.#now = options.now ?? epochSeconds;
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.#issuer.origin,
      authorization_endpoint: new URL("/oauth/authorize", this.#issuer).href,
      token_endpoint: new URL("/oauth/token", this.#issuer).href,
      registration_endpoint: new URL("/oauth/register", this.#issuer).href,
      revocation_endpoint: new URL("/oauth/revoke", this.#issuer).href,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_WRITE_SCOPE],
    };
  }

  async route(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === "/oauth/register") return this.#register(request);
    if (path === "/oauth/authorize") return this.#authorize(request);
    if (path === "/oauth/token") return this.#token(request);
    if (path === "/oauth/revoke") return this.#revoke(request);
    return undefined;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = digest(token);
    const grant = this.#accessTokens.get(key);
    if (grant === undefined || grant.expires_at <= this.#now()) {
      this.#accessTokens.delete(key);
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
    return {
      token,
      clientId: grant.client_id,
      scopes: [...grant.scope],
      expiresAt: grant.expires_at,
      resource: new URL(grant.resource),
      extra: { [AUTH_PRINCIPAL_KEY]: grant.principal },
    };
  }

  async #register(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (this.#clients.size >= 100) return oauthError("temporarily_unavailable", "Client registration capacity reached", 503);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return oauthError("invalid_client_metadata", "Registration body must be JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return oauthError("invalid_client_metadata", "Invalid client metadata");
    const input = body as Record<string, unknown>;
    if (!Array.isArray(input.redirect_uris)
      || input.redirect_uris.length === 0
      || input.redirect_uris.length > 10
      || !input.redirect_uris.every((uri) => typeof uri === "string" && redirectAllowed(uri))) {
      return oauthError("invalid_redirect_uri", "A valid HTTPS redirect URI is required");
    }
    const tokenMethod = input.token_endpoint_auth_method ?? "none";
    if (tokenMethod !== "none") return oauthError("invalid_client_metadata", "Only public PKCE clients are supported");
    const client: StoredClient = {
      client_id: opaqueToken(24),
      redirect_uris: [...input.redirect_uris] as string[],
      ...(typeof input.client_name === "string" ? { client_name: input.client_name.slice(0, 120) } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: this.#now(),
    };
    this.#clients.set(client.client_id, client);
    return json(client, 201);
  }

  async #authorize(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    let params: URLSearchParams;
    try {
      params = request.method === "GET" ? new URL(request.url).searchParams : await form(request);
    } catch {
      return oauthError("invalid_request", "Authorization request must be form encoded");
    }
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state") ?? undefined;
    const client = this.#clients.get(clientId);
    if (client === undefined || !client.redirect_uris.includes(redirectUri)) return oauthError("invalid_request", "Unknown client or redirect URI");
    if (params.get("response_type") !== "code") return redirectWith(redirectUri, { error: "unsupported_response_type", state });
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || challenge.length < 43 || challenge.length > 128) {
      return redirectWith(redirectUri, { error: "invalid_request", state });
    }
    const resource = params.get("resource") ?? this.#resource.href;
    if (resource !== this.#resource.href) return redirectWith(redirectUri, { error: "invalid_target", state });
    let scopes: string[];
    try {
      scopes = parseScope(params.get("scope"));
    } catch {
      return redirectWith(redirectUri, { error: "invalid_scope", state });
    }

    if (request.method === "GET") {
      const hidden = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
        .map((name) => `<input type="hidden" name="${name}" value="${html(params.get(name) ?? "")}">`)
        .join("");
      const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Agent Feed</title><style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#17202a}form{display:grid;gap:1rem}input,button{font:inherit;padding:.7rem}small{color:#566573}</style></head><body><h1>Authorize Agent Feed</h1><p>Allow <strong>${html(client.client_name ?? "this MCP client")}</strong> to submit runs for producer <strong>${html(this.#principal.producer_id)}</strong>.</p><form method="post">${hidden}<label>Operator passphrase<input name="operator_secret" type="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form><small>This pilot grant is memory-only and expires automatically.</small></body></html>`;
      return new Response(body, { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } });
    }
    if (!equalSecret(params.get("operator_secret") ?? "", this.#operatorSecret)) {
      return new Response("Authorization denied", { status: 403, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
    }
    const code = opaqueToken();
    this.#codes.set(digest(code), {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      scope: scopes,
      resource,
      expires_at: this.#now() + this.#codeTtl,
      principal: this.#principal,
    });
    return redirectWith(redirectUri, { code, state });
  }

  async #token(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    let params: URLSearchParams;
    try {
      params = await form(request);
    } catch {
      return oauthError("invalid_request", "Token request must be form encoded");
    }
    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") return this.#exchangeCode(params);
    if (grantType === "refresh_token") return this.#refresh(params);
    return oauthError("unsupported_grant_type", "Unsupported grant type");
  }

  #exchangeCode(params: URLSearchParams): Response {
    const code = params.get("code") ?? "";
    const key = digest(code);
    const grant = this.#codes.get(key);
    this.#codes.delete(key);
    if (grant === undefined
      || grant.expires_at <= this.#now()
      || params.get("client_id") !== grant.client_id
      || params.get("redirect_uri") !== grant.redirect_uri
      || params.get("resource") !== grant.resource
      || digest(params.get("code_verifier") ?? "") !== grant.code_challenge) {
      return oauthError("invalid_grant", "Authorization code is invalid");
    }
    return this.#issueTokens(grant);
  }

  #refresh(params: URLSearchParams): Response {
    const refreshToken = params.get("refresh_token") ?? "";
    const key = digest(refreshToken);
    const grant = this.#refreshTokens.get(key);
    this.#refreshTokens.delete(key);
    if (grant === undefined
      || grant.expires_at <= this.#now()
      || params.get("client_id") !== grant.client_id
      || params.get("resource") !== grant.resource) {
      return oauthError("invalid_grant", "Refresh token is invalid");
    }
    return this.#issueTokens(grant);
  }

  #issueTokens(grant: Pick<TokenGrant, "client_id" | "scope" | "resource" | "principal">): Response {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const now = this.#now();
    this.#accessTokens.set(digest(accessToken), { ...grant, expires_at: now + this.#accessTtl });
    this.#refreshTokens.set(digest(refreshToken), { ...grant, expires_at: now + this.#refreshTtl });
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.#accessTtl,
      refresh_token: refreshToken,
      scope: grant.scope.join(" "),
    });
  }

  async #revoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    try {
      const params = await form(request);
      const key = digest(params.get("token") ?? "");
      this.#accessTokens.delete(key);
      this.#refreshTokens.delete(key);
      return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    } catch {
      return oauthError("invalid_request", "Revocation request must be form encoded");
    }
  }
}
