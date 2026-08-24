import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PersistentOAuthProvider,
  type AuthorizationGrant,
  type OAuthStateStore,
  type StoredClient,
  type TokenGrant,
} from "../src/persistent-auth.ts";

class MemoryDurableStore implements OAuthStateStore {
  clients = new Map<string, StoredClient>();
  codes = new Map<string, AuthorizationGrant>();
  access = new Map<string, TokenGrant>();
  refresh = new Map<string, TokenGrant>();

  async countClients() { return this.clients.size; }
  async getClient(id: string) { return this.clients.get(id); }
  async putClient(value: StoredClient) { this.clients.set(value.client_id, value); }
  async putCode(hash: string, value: AuthorizationGrant) { this.codes.set(hash, value); }
  async takeCode(hash: string) { const value = this.codes.get(hash); this.codes.delete(hash); return value; }
  async putAccessToken(hash: string, value: TokenGrant) { this.access.set(hash, value); }
  async getAccessToken(hash: string) { return this.access.get(hash); }
  async putRefreshToken(hash: string, value: TokenGrant) { this.refresh.set(hash, value); }
  async takeRefreshToken(hash: string) { const value = this.refresh.get(hash); this.refresh.delete(hash); return value; }
  async revokeToken(hash: string) { this.access.delete(hash); this.refresh.delete(hash); }
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function provider(store: OAuthStateStore) {
  return new PersistentOAuthProvider({
    issuer: new URL("https://agent-feed.example/mcp"),
    resource: new URL("https://agent-feed.example/mcp"),
    operator_secret: "operator-secret-that-is-long-enough",
    principal: {
      tenant_id: "tenant_test",
      producer_id: "chatgpt-scheduled-task",
      allowed_stream_ids: ["economy.paypay"],
    },
    store,
    now: () => 1_800_000_000,
  });
}

test("authorization code and tokens survive provider cold starts", async () => {
  const store = new MemoryDurableStore();
  const first = provider(store);
  const registration = await first.route(new Request("https://agent-feed.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
      token_endpoint_auth_method: "none",
    }),
  }));
  assert.equal(registration?.status, 201);
  const client = await registration!.json() as StoredClient;

  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeValues = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0]!,
    response_type: "code",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "agent-feed:write",
    resource: "https://agent-feed.example/mcp",
    operator_secret: "operator-secret-that-is-long-enough",
  };
  const approval = await first.route(new Request("https://agent-feed.example/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(authorizeValues),
    redirect: "manual",
  }));
  assert.equal(approval?.status, 302);
  const code = new URL(approval!.headers.get("location")!).searchParams.get("code");
  assert.ok(code);

  // Simulate a deployment/cold start: a brand-new provider reads the same
  // durable store and must still exchange the authorization code.
  const second = provider(store);
  const tokenResponse = await second.route(new Request("https://agent-feed.example/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      code_verifier: verifier,
      resource: "https://agent-feed.example/mcp",
    }),
  }));
  assert.equal(tokenResponse?.status, 200);
  const token = await tokenResponse!.json() as { access_token: string; refresh_token: string };

  // A third cold start must accept the previously issued access token.
  const third = provider(store);
  const auth = await third.verifyAccessToken(token.access_token);
  assert.equal(auth.clientId, client.client_id);
  assert.deepEqual(auth.scopes, ["agent-feed:write"]);

  // Refresh-token rotation also survives provider replacement.
  const refresh = await third.route(new Request("https://agent-feed.example/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: client.client_id,
      resource: "https://agent-feed.example/mcp",
    }),
  }));
  assert.equal(refresh?.status, 200);
});
