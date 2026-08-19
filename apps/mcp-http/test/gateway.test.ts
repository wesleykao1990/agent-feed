import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import {
  AUTH_PRINCIPAL_KEY,
  MCP_WRITE_SCOPE,
  PilotOAuthProvider,
  createMcpHttpGateway,
  type AccessTokenVerifier,
} from "../src/index.ts";

const PUBLIC_URL = new URL("https://feed.example/mcp");
const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant-test",
  producer_id: "claude-test",
  allowed_stream_ids: ["rewards-watch"],
  credential_id: "credential-test",
};

class FakeService {
  calls: Array<{ name: string; principal: ProducerPrincipal }> = [];
  security = { max_body_bytes: 65_536 };

  async beginRun(_value: unknown, principal: ProducerPrincipal): Promise<Record<string, unknown>> {
    this.calls.push({ name: "begin_run", principal });
    return { run_id: "run-http-001", status: "running" };
  }

  async submitBatch(_runId: string, _value: unknown, principal: ProducerPrincipal): Promise<Record<string, unknown>> {
    this.calls.push({ name: "submit_batch", principal });
    return { run_id: "run-http-001", status: "running" };
  }

  async completeRun(_runId: string, _value: unknown, principal: ProducerPrincipal): Promise<Record<string, unknown>> {
    this.calls.push({ name: "complete_run", principal });
    return { run_id: "run-http-001", status: "completed" };
  }
}

class FixedVerifier implements AccessTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token !== "valid-token") throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    return {
      token,
      clientId: "client-test",
      scopes: [MCP_WRITE_SCOPE],
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      resource: PUBLIC_URL,
      extra: { [AUTH_PRINCIPAL_KEY]: PRINCIPAL },
    };
  }
}

function modernParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "gateway-test", version: "1" },
    },
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "feed.example");
  return new Request(new URL(path, PUBLIC_URL), { ...init, headers });
}

function mcpRequest(body: Record<string, unknown>, token = "valid-token", headers: HeadersInit = {}): Request {
  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : undefined;
  return request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": String(body.method ?? ""),
      ...(typeof params?.name === "string" ? { "mcp-name": params.name } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
});
}

function beginArguments(): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    idempotency_key: "begin-http-test-001",
    stream_id: "rewards-watch",
    producer: { producer_id: "claude-test", type: "claude", name: "Claude", version: null },
    task: { task_type: "integration-test", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: ["integration"], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
  };
}

test("gateway requires bounded bearer auth and advertises protected-resource discovery", async () => {
  const gateway = createMcpHttpGateway({ public_url: PUBLIC_URL, service: new FakeService(), verifier: new FixedVerifier() });
  try {
    const missing = await gateway.fetch(request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /resource_metadata=/u);

    const invalid = await gateway.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "server/discover", params: modernParams() }, "wrong"));
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: "invalid_token", error_description: "Invalid access token" });
  } finally {
    await gateway.close();
  }
});

test("gateway exposes exactly the shared lifecycle tools over modern Streamable HTTP", async () => {
  const service = new FakeService();
  const gateway = createMcpHttpGateway({ public_url: PUBLIC_URL, service, verifier: new FixedVerifier() });
  try {
    const response = await gateway.fetch(mcpRequest({
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
      params: modernParams(),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    assert.equal(result.resultType, "complete");
    const names = (result.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
    assert.deepEqual(names, ["begin_run", "submit_batch", "complete_run"]);
    assert.equal(service.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("gateway injects the authenticated principal and rejects credential-shaped tool arguments", async () => {
  const service = new FakeService();
  const gateway = createMcpHttpGateway({ public_url: PUBLIC_URL, service, verifier: new FixedVerifier() });
  try {
    const accepted = await gateway.fetch(mcpRequest({
      jsonrpc: "2.0",
      id: "begin-1",
      method: "tools/call",
      params: modernParams({ name: "begin_run", arguments: beginArguments() }),
    }));
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(service.calls, [{ name: "begin_run", principal: PRINCIPAL }]);

    const rejected = await gateway.fetch(mcpRequest({
      jsonrpc: "2.0",
      id: "begin-secret",
      method: "tools/call",
      params: modernParams({ name: "begin_run", arguments: { ...beginArguments(), authorization: "must-not-leak" } }),
    }));
    assert.equal(rejected.status, 200);
    const body = await rejected.text();
    assert.match(body, /authentication_fields_are_not_tool_arguments/u);
    assert.doesNotMatch(body, /must-not-leak/u);
    assert.equal(service.calls.length, 1);
  } finally {
    await gateway.close();
  }
});

test("gateway rejects Host, Origin, and oversized requests before MCP dispatch", async () => {
  const gateway = createMcpHttpGateway({
    public_url: PUBLIC_URL,
    service: new FakeService(),
    verifier: new FixedVerifier(),
    allowed_origins: ["https://claude.ai"],
    max_body_bytes: 1_024,
  });
  try {
    const wrongHost = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modernParams() });
    wrongHost.headers.set("host", "attacker.example");
    assert.equal((await gateway.fetch(wrongHost)).status, 421);

    const wrongOrigin = mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: modernParams() }, "valid-token", { origin: "https://attacker.example" });
    assert.equal((await gateway.fetch(wrongOrigin)).status, 403);

    const tooLarge = mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list", params: modernParams() }, "valid-token", { "content-length": "2048" });
    assert.equal((await gateway.fetch(tooLarge)).status, 413);
  } finally {
    await gateway.close();
  }
});

test("pilot OAuth supports DCR, operator consent, PKCE, one-time codes, refresh rotation, and revocation", async () => {
  let now = 1_800_000_000;
  const oauth = new PilotOAuthProvider({
    issuer: PUBLIC_URL,
    resource: PUBLIC_URL,
    operator_secret: "correct horse battery staple 123",
    principal: PRINCIPAL,
    now: () => now,
  });
  const gateway = createMcpHttpGateway({ public_url: PUBLIC_URL, service: new FakeService(), verifier: oauth, oauth });
  try {
    const metadata = await gateway.fetch(request("/.well-known/oauth-protected-resource/mcp"));
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json() as Record<string, unknown>).resource, PUBLIC_URL.href);

    const registered = await gateway.fetch(request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude acceptance", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
    }));
    assert.equal(registered.status, 201);
    const client = await registered.json() as Record<string, unknown>;
    const clientId = String(client.client_id);
    const verifier = "this-is-a-long-pkce-verifier-value-for-the-test-123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL("/oauth/authorize", PUBLIC_URL);
    authorization.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: MCP_WRITE_SCOPE,
      resource: PUBLIC_URL.href,
    }).toString();
    const consent = await gateway.fetch(request(`${authorization.pathname}${authorization.search}`));
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /Authorize Agent Feed/u);

    const consentParams = new URLSearchParams(authorization.search);
    consentParams.set("operator_secret", "correct horse battery staple 123");
    const approved = await gateway.fetch(request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: consentParams,
    }));
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location")!);
    const code = callback.searchParams.get("code")!;
    assert.equal(callback.searchParams.get("state"), "state-1");

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
      resource: PUBLIC_URL.href,
    });
    const exchanged = await gateway.fetch(request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenParams,
    }));
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json() as Record<string, unknown>;
    const auth = await oauth.verifyAccessToken(String(tokens.access_token));
    assert.equal(auth.clientId, clientId);
    assert.deepEqual(auth.extra?.[AUTH_PRINCIPAL_KEY], PRINCIPAL);

    const replay = await gateway.fetch(request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenParams,
    }));
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as Record<string, unknown>).error, "invalid_grant");

    const refreshParams = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
      client_id: clientId,
      resource: PUBLIC_URL.href,
    });
    const refreshed = await gateway.fetch(request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshParams,
    }));
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json() as Record<string, unknown>;
    now += 1;
    const revoked = await gateway.fetch(request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: String(rotated.access_token) }),
    }));
    assert.equal(revoked.status, 200);
    await assert.rejects(() => oauth.verifyAccessToken(String(rotated.access_token)), /Invalid access token/u);
  } finally {
    await gateway.close();
  }
});
