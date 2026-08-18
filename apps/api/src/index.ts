import type { Server } from "node:http";
import {
  ProducerService,
  StaticProducerAuthenticator,
  type ProducerAuthenticator,
  type ProducerCredential,
  type ProducerPersistence,
  type RateLimitOptions,
} from "@agent-feed/producer-service";
import { createRestServer } from "@agent-feed/rest-adapter";

export interface AgentFeedApiOptions {
  /** Prefer injecting the fully composed application service in production. */
  service?: ProducerService;
  /** Convenience composition for the executable app and live conformance harness. */
  persistence?: ProducerPersistence;
  authenticator?: ProducerAuthenticator;
  credentials?: readonly ProducerCredential[];
  producerCredentials?: readonly ProducerCredential[];
  /** Optional limiter override for tests or a deployment-specific policy. */
  rate_limit?: RateLimitOptions;
  /** Maximum JSON request body. Defaults to the service security policy. */
  max_body_bytes?: number;
}

function asCredential(value: ProducerCredential | Record<string, unknown>): ProducerCredential {
  const input = value as Record<string, unknown>;
  const tenant = input.tenant_id ?? input.tenantId;
  const producer = input.producer_id ?? input.producerId;
  const streams = input.allowed_stream_ids ?? input.allowedStreamIds;
  if (typeof tenant !== "string" || typeof producer !== "string" || typeof input.secret !== "string" || !Array.isArray(streams) || !streams.every((item) => typeof item === "string")) {
    throw new Error("invalid_producer_credential");
  }
  const result: ProducerCredential = {
    tenant_id: tenant,
    producer_id: producer,
    secret: input.secret,
    allowed_stream_ids: streams,
  };
  const credentialId = input.credential_id ?? input.credentialId;
  if (typeof credentialId === "string") result.credential_id = credentialId;
  const expiresAt = input.expires_at ?? input.expiresAt;
  if (typeof expiresAt === "string" || typeof expiresAt === "number" || expiresAt instanceof Date) result.expires_at = expiresAt;
  return result;
}

function resolveService(options: AgentFeedApiOptions): ProducerService {
  if (options.service && typeof (options.service as unknown as { authenticate?: unknown }).authenticate === "function") return options.service;
  // Keep the composition root tolerant of older harnesses that used the
  // names `service`/`store` for the persistence object. They are normalized
  // here; the resulting application service remains the only policy boundary.
  const persistence = options.persistence ?? (
    options.service && typeof (options.service as unknown as { beginRun?: unknown }).beginRun === "function"
      ? options.service as unknown as ProducerPersistence
      : undefined
  );
  if (!persistence) throw new Error("service_or_persistence_required");
  const configured = options.credentials ?? options.producerCredentials;
  const authenticator = options.authenticator ?? (
    configured ? new StaticProducerAuthenticator(configured.map((item) => asCredential(item))) : undefined
  );
  if (!authenticator) throw new Error("authenticator_or_credentials_required");
  return new ProducerService({
    persistence,
    authenticator,
    ...(options.rate_limit === undefined ? {} : { rate_limit: options.rate_limit }),
  });
}

/**
 * Compatibility composition root for the durable producer API. Routing,
 * request framing, authentication mapping, and public error responses live in
 * `@agent-feed/rest-adapter`; this app keeps the historical options and public
 * function name while constructing the shared producer service.
 */
export function createAgentFeedApiServer(options: AgentFeedApiOptions): Server {
  const service = resolveService(options);
  return createRestServer({
    service,
    service_name: "agent-feed-api",
    ...(options.max_body_bytes === undefined ? {} : { max_body_bytes: options.max_body_bytes }),
  });
}
