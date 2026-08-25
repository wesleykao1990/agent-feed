import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import {
  GITHUB_ACTIONS_OIDC_AUDIENCE,
  GITHUB_ACTIONS_OIDC_ISSUER,
  GitHubActionsOidcVerifier,
} from "../src/github-actions-oidc.ts";
import { principalFromAuthInfo } from "../src/auth.ts";

const RESOURCE = new URL("https://feed.example/mcp");
const REPOSITORY = "wesleykao1990/agent-feed";
const REPOSITORY_ID = "1337089949";
const REF = "refs/heads/main";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/agent-feed-relay.yml@${REF}`;
const NOW = 1_787_642_400;
const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant-test",
  producer_id: "chatgpt-scheduled-task",
  allowed_stream_ids: ["economy.jp-credit-cards"],
};

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
): string {
  const header = segment({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = segment(claims);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    aud: GITHUB_ACTIONS_OIDC_AUDIENCE,
    sub: "repo:wesleykao1990/agent-feed:ref:refs/heads/main",
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner: "wesleykao1990",
    actor: "wesleykao1990",
    ref: REF,
    event_name: "issues",
    job_workflow_ref: WORKFLOW_REF,
    runner_environment: "github-hosted",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    ...extra,
  };
}

function setup(): {
  verifier: GitHubActionsOidcVerifier;
  privateKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        jwks_uri: `${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`,
      });
    }
    if (url.pathname === "/.well-known/jwks") {
      return Response.json({
        keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    privateKey,
    verifier: new GitHubActionsOidcVerifier({
      resource: RESOURCE,
      principal: PRINCIPAL,
      repository: REPOSITORY,
      repository_id: REPOSITORY_ID,
      ref: REF,
      workflow_ref: WORKFLOW_REF,
      fetcher,
      now: () => NOW,
    }),
  };
}

test("accepts an owner-triggered token for the exact repository workflow", async () => {
  const { verifier, privateKey } = setup();
  const auth = await verifier.verifyAccessToken(token(privateKey, claims()));
  assert.equal(auth.clientId, `github-actions:${REPOSITORY_ID}`);
  assert.deepEqual(auth.scopes, ["agent-feed:write"]);
  assert.deepEqual(principalFromAuthInfo(auth), PRINCIPAL);
});

test("rejects a public issue author even when the repository and workflow match", async () => {
  const { verifier, privateKey } = setup();
  await assert.rejects(
    verifier.verifyAccessToken(token(privateKey, claims({ actor: "not-the-owner" }))),
    /Invalid access token/u,
  );
});

test("rejects a token from any other workflow or branch", async () => {
  const { verifier, privateKey } = setup();
  await assert.rejects(
    verifier.verifyAccessToken(token(privateKey, claims({
      job_workflow_ref: `${REPOSITORY}/.github/workflows/other.yml@${REF}`,
    }))),
    /Invalid access token/u,
  );
  await assert.rejects(
    verifier.verifyAccessToken(token(privateKey, claims({ ref: "refs/heads/feature" }))),
    /Invalid access token/u,
  );
});

test("rejects tampered claims after signature verification", async () => {
  const { verifier, privateKey } = setup();
  const original = token(privateKey, claims());
  const [header, , signature] = original.split(".");
  const tampered = `${header}.${segment(claims({ repository_id: "999" }))}.${signature}`;
  await assert.rejects(
    verifier.verifyAccessToken(tampered),
    /Invalid access token/u,
  );
});
