import {
  ProducerService,
  StaticProducerAuthenticator,
  type ProducerCredential,
  type ProducerPersistence,
  type ProducerPrincipal,
} from "@agent-feed/producer-service";
import { createOfficialMcpServer } from "./sdk.ts";
import type { McpServerOptions, ProducerServiceBoundary } from "./types.ts";
import type { Server as OfficialMcpServer } from "@modelcontextprotocol/server";

export interface McpEnvironment {
  readonly [key: string]: string | undefined;
}

export interface McpEnvironmentCompositionOptions {
  /** Injected service is preferred when the deployment already composed one. */
  service?: ProducerServiceBoundary;
  /** Used only when a service is not injected. */
  persistence?: ProducerPersistence;
  principal?: ProducerPrincipal;
  auth_principal?: ProducerPrincipal;
  authPrincipal?: ProducerPrincipal;
  env?: McpEnvironment;
  server_name?: string;
  server_version?: string;
  max_argument_bytes?: number;
}

function credential(value: unknown): ProducerCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_producer_credential");
  const input = value as Record<string, unknown>;
  const tenant = input.tenant_id ?? input.tenantId;
  const producer = input.producer_id ?? input.producerId;
  const streams = input.allowed_stream_ids ?? input.allowedStreamIds;
  if (typeof tenant !== "string"
    || typeof producer !== "string"
    || typeof input.secret !== "string"
    || input.secret.length === 0
    || !Array.isArray(streams)
    || !streams.every((item) => typeof item === "string")) {
    throw new Error("invalid_producer_credential");
  }
  const result: ProducerCredential = {
    tenant_id: tenant,
    producer_id: producer,
    secret: input.secret,
    allowed_stream_ids: [...streams] as string[],
  };
  const credentialId = input.credential_id ?? input.credentialId;
  if (typeof credentialId === "string") result.credential_id = credentialId;
  const expiresAt = input.expires_at ?? input.expiresAt;
  if (typeof expiresAt === "string" || typeof expiresAt === "number" || expiresAt instanceof Date) result.expires_at = expiresAt;
  return result;
}

export function credentialsFromEnvironment(env: McpEnvironment = process.env): ProducerCredential[] {
  const raw = env.AGENT_FEED_PRODUCER_CREDENTIALS;
  if (raw !== undefined && raw.length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("invalid_producer_credentials");
    }
    if (!Array.isArray(value) || value.length === 0) throw new Error("invalid_producer_credentials");
    return value.map((item) => credential(item));
  }
  const tenant = env.AGENT_FEED_TENANT_ID;
  const producer = env.AGENT_FEED_PRODUCER_ID;
  const secret = env.AGENT_FEED_PRODUCER_SECRET;
  const streams = (env.AGENT_FEED_ALLOWED_STREAMS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tenant || !producer || !secret || streams.length === 0) {
    throw new Error("producer_credentials_required");
  }
  return [{ tenant_id: tenant, producer_id: producer, secret, allowed_stream_ids: streams }];
}

export function authorizationFromEnvironment(
  credentials: readonly ProducerCredential[],
  env: McpEnvironment = process.env,
): string {
  const configuredAuthorization = env.AGENT_FEED_MCP_AUTHORIZATION;
  if (configuredAuthorization !== undefined && configuredAuthorization.length > 0) return configuredAuthorization;
  const configuredSecret = env.AGENT_FEED_MCP_PRODUCER_SECRET ?? env.AGENT_FEED_PRODUCER_SECRET;
  if (configuredSecret !== undefined && configuredSecret.length > 0) return `Bearer ${configuredSecret}`;
  if (credentials.length === 1) return `Bearer ${credentials[0]!.secret}`;
  throw new Error("mcp_authorization_required");
}

function serviceFromEnvironment(
  options: McpEnvironmentCompositionOptions,
  env: McpEnvironment,
): { service: ProducerServiceBoundary; authorization?: string } {
  if (options.service !== undefined) {
    if (options.principal !== undefined || options.auth_principal !== undefined || options.authPrincipal !== undefined) return { service: options.service };
    // An already-composed service may own its credential set. In that case a
    // direct MCP authorization value is sufficient; do not require the
    // composition root to duplicate the service's credentials in its env.
    const directAuthorization = env.AGENT_FEED_MCP_AUTHORIZATION;
    if (directAuthorization !== undefined && directAuthorization.length > 0) {
      return { service: options.service, authorization: directAuthorization };
    }
    const directSecret = env.AGENT_FEED_MCP_PRODUCER_SECRET ?? env.AGENT_FEED_PRODUCER_SECRET;
    if (directSecret !== undefined && directSecret.length > 0) {
      return { service: options.service, authorization: `Bearer ${directSecret}` };
    }
    return { service: options.service, authorization: authorizationFromEnvironment(credentialsFromEnvironment(env), env) };
  }
  if (options.persistence === undefined) throw new Error("service_or_persistence_required");
  const credentials = credentialsFromEnvironment(env);
  const service = new ProducerService({
    persistence: options.persistence,
    authenticator: new StaticProducerAuthenticator(credentials),
  });
  return { service, authorization: authorizationFromEnvironment(credentials, env) };
}

/** Build the official SDK server with the same environment/injection policy. */
export function createOfficialMcpServerFromEnvironment(options: McpEnvironmentCompositionOptions): OfficialMcpServer {
  return createOfficialMcpServer(optionsFromEnvironment(options));
}

function optionsFromEnvironment(options: McpEnvironmentCompositionOptions): McpServerOptions {
  const env = options.env ?? process.env;
  const composition = serviceFromEnvironment(options, env);
  return {
    service: composition.service,
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.auth_principal === undefined ? {} : { auth_principal: options.auth_principal }),
    ...(options.authPrincipal === undefined ? {} : { authPrincipal: options.authPrincipal }),
    ...(composition.authorization === undefined ? {} : { authorization: composition.authorization }),
    ...(options.server_name === undefined ? {} : { server_name: options.server_name }),
    ...(options.server_version === undefined ? {} : { server_version: options.server_version }),
    ...(options.max_argument_bytes === undefined ? {} : { max_argument_bytes: options.max_argument_bytes }),
  };
}
