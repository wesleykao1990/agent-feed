import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import {
  AUTH_PRINCIPAL_KEY,
  MCP_WRITE_SCOPE,
  type AccessTokenVerifier,
} from "./auth.ts";

export const GITHUB_ACTIONS_OIDC_AUDIENCE =
  "urn:agent-feed:github-actions" as const;
export const GITHUB_ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com" as const;

const PROVIDER_DOCUMENT_MAX_BYTES = 65_536;
const JWKS_CACHE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_AGE_SECONDS = 600;

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as JsonObject;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeJsonSegment(value: string): JsonObject | undefined {
  try {
    return record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string") &&
    value.includes(expected)
  );
}

async function boundedJson(
  fetcher: typeof fetch,
  url: URL,
): Promise<JsonObject> {
  const response = await fetcher(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("github_oidc_provider_unavailable");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > PROVIDER_DOCUMENT_MAX_BYTES)
    throw new Error("github_oidc_provider_document_too_large");
  const parsed = record(JSON.parse(body));
  if (parsed === undefined) throw new Error("github_oidc_provider_invalid");
  return parsed;
}

export interface GitHubActionsOidcVerifierOptions {
  resource: URL;
  principal: ProducerPrincipal;
  repository: string;
  repository_id: string;
  ref: string;
  workflow_ref: string;
  audience?: string;
  issuer?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface CachedJwks {
  expires_at: number;
  keys: JsonObject[];
}

/**
 * Verifies short-lived GitHub Actions OIDC tokens for one exact repository,
 * ref, and workflow. The token only maps to the already-configured producer
 * principal; it never creates or expands stream authority.
 */
export class GitHubActionsOidcVerifier implements AccessTokenVerifier {
  readonly #resource: URL;
  readonly #principal: ProducerPrincipal;
  readonly #repository: string;
  readonly #repositoryId: string;
  readonly #repositoryOwner: string;
  readonly #ref: string;
  readonly #workflowRef: string;
  readonly #audience: string;
  readonly #issuer: URL;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  #jwks: CachedJwks | undefined;

  constructor(options: GitHubActionsOidcVerifierOptions) {
    const repositoryOwner = options.repository.split("/", 1)[0];
    if (
      options.resource.protocol !== "https:" ||
      options.repository.length === 0 ||
      options.repository_id.length === 0 ||
      repositoryOwner === undefined ||
      repositoryOwner.length === 0 ||
      options.ref.length === 0 ||
      options.workflow_ref.length === 0
    ) {
      throw new Error("github_oidc_configuration_invalid");
    }
    const issuer = new URL(options.issuer ?? GITHUB_ACTIONS_OIDC_ISSUER);
    if (issuer.protocol !== "https:" || issuer.pathname !== "/")
      throw new Error("github_oidc_issuer_invalid");
    this.#resource = new URL(options.resource.href);
    this.#principal = {
      ...options.principal,
      allowed_stream_ids: [...options.principal.allowed_stream_ids],
    };
    this.#repository = options.repository;
    this.#repositoryId = options.repository_id;
    this.#repositoryOwner = repositoryOwner;
    this.#ref = options.ref;
    this.#workflowRef = options.workflow_ref;
    this.#audience = options.audience ?? GITHUB_ACTIONS_OIDC_AUDIENCE;
    this.#issuer = issuer;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("github_oidc_token_invalid");
      const header = decodeJsonSegment(parts[0]!);
      const claims = decodeJsonSegment(parts[1]!);
      if (header === undefined || claims === undefined)
        throw new Error("github_oidc_token_invalid");
      if (
        header.alg !== "RS256" ||
        (header.typ !== undefined && header.typ !== "JWT")
      ) {
        throw new Error("github_oidc_algorithm_invalid");
      }
      const kid = stringValue(header.kid);
      if (kid === undefined) throw new Error("github_oidc_kid_required");
      const key = await this.#key(kid);
      const verified = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
        key,
        Buffer.from(parts[2]!, "base64url"),
      );
      if (!verified) throw new Error("github_oidc_signature_invalid");

      const now = this.#now();
      const exp = numberValue(claims.exp);
      const nbf = numberValue(claims.nbf);
      const iat = numberValue(claims.iat);
      if (
        claims.iss !== this.#issuer.origin ||
        !audienceMatches(claims.aud, this.#audience) ||
        claims.repository !== this.#repository ||
        claims.repository_id !== this.#repositoryId ||
        claims.repository_owner !== this.#repositoryOwner ||
        claims.actor !== this.#repositoryOwner ||
        claims.ref !== this.#ref ||
        claims.event_name !== "issues" ||
        claims.job_workflow_ref !== this.#workflowRef ||
        claims.runner_environment !== "github-hosted" ||
        exp === undefined ||
        iat === undefined ||
        exp < now - CLOCK_SKEW_SECONDS ||
        (nbf !== undefined && nbf > now + CLOCK_SKEW_SECONDS) ||
        iat > now + CLOCK_SKEW_SECONDS ||
        iat < now - MAX_TOKEN_AGE_SECONDS
      ) {
        throw new Error("github_oidc_claims_invalid");
      }

      return {
        token,
        clientId: `github-actions:${this.#repositoryId}`,
        scopes: [MCP_WRITE_SCOPE],
        expiresAt: exp,
        resource: this.#resource,
        extra: { [AUTH_PRINCIPAL_KEY]: this.#principal },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
  }

  async #key(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const now = this.#now();
    if (this.#jwks === undefined || this.#jwks.expires_at <= now) {
      const discoveryUrl = new URL("/.well-known/openid-configuration", this.#issuer);
      const discovery = await boundedJson(this.#fetcher, discoveryUrl);
      if (discovery.issuer !== this.#issuer.origin)
        throw new Error("github_oidc_discovery_issuer_invalid");
      const jwksUri = stringValue(discovery.jwks_uri);
      if (jwksUri === undefined) throw new Error("github_oidc_jwks_uri_required");
      const jwksUrl = new URL(jwksUri);
      if (
        jwksUrl.protocol !== "https:" ||
        jwksUrl.origin !== this.#issuer.origin
      ) {
        throw new Error("github_oidc_jwks_uri_invalid");
      }
      const jwks = await boundedJson(this.#fetcher, jwksUrl);
      if (!Array.isArray(jwks.keys)) throw new Error("github_oidc_jwks_invalid");
      const keys = jwks.keys.map(record).filter((item): item is JsonObject => item !== undefined);
      if (keys.length === 0 || keys.length > 32)
        throw new Error("github_oidc_jwks_invalid");
      this.#jwks = { expires_at: now + JWKS_CACHE_SECONDS, keys };
    }
    const jwk = this.#jwks.keys.find(
      (candidate) =>
        candidate.kid === kid &&
        candidate.kty === "RSA" &&
        (candidate.use === undefined || candidate.use === "sig") &&
        (candidate.alg === undefined || candidate.alg === "RS256"),
    );
    if (jwk === undefined) throw new Error("github_oidc_signing_key_not_found");
    return createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  }
}
