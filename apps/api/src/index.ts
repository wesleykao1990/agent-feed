import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ProducerService,
  ProducerServiceError,
  StaticProducerAuthenticator,
  type ProducerAuthenticator,
  type ProducerCredential,
  type ProducerPersistence,
  type ProducerPrincipal,
  type RateLimitOptions,
} from "@agent-feed/producer-service";

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

function writeJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    req.resume();
    throw new ProducerServiceError("unsupported_media_type", "content-type must be application/json");
  }
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new ProducerServiceError("invalid_input", "content-length is invalid");
    if (length > maxBytes) {
      req.resume();
      throw new ProducerServiceError("body_too_large", "request body exceeds the configured limit");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      req.resume();
      throw new ProducerServiceError("body_too_large", "request body exceeds the configured limit");
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new ProducerServiceError("invalid_json", "request body must contain JSON");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProducerServiceError("invalid_json", "request body is not valid JSON");
  }
}

function decodedRunId(pathPart: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    throw new ProducerServiceError("invalid_input", "run_id is not valid URL encoding");
  }
  if (decoded.length === 0 || decoded.includes("/")) throw new ProducerServiceError("invalid_input", "run_id is invalid");
  return decoded;
}

function errorResponse(error: unknown): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  if (error instanceof ProducerServiceError) {
    const headers: Record<string, string> = {};
    if (error.status === 401) headers["www-authenticate"] = "Bearer";
    if (error.retry_after_seconds !== null) headers["retry-after"] = String(error.retry_after_seconds);
    return {
      status: error.status,
      body: { error: error.code },
      headers,
    };
  }
  return { status: 503, body: { error: "storage_error" }, headers: {} };
}

function principalRequest(req: IncomingMessage): { authorization?: string } {
  const authorization = req.headers.authorization;
  return authorization === undefined ? {} : { authorization };
}

function healthBody(service: ProducerService): Record<string, unknown> {
  return {
    ok: true,
    service: "agent-feed-api",
    protocol_version: "0.1",
    security: {
      max_body_bytes: service.security.max_body_bytes,
      max_findings_per_batch: service.security.max_findings_per_batch,
      max_evidence_per_batch: service.security.max_evidence_per_batch,
      max_evidence_excerpt_characters: service.security.max_evidence_excerpt_characters,
      producer_requests_per_minute: service.rate_limiter.max_requests_per_minute,
      producer_burst: service.rate_limiter.burst,
      producer_burst_window_ms: service.rate_limiter.burst_window_ms,
    },
  };
}

/**
 * Durable producer HTTP adapter. All lifecycle policy is delegated to the
 * injected ProducerService; this module contains routing and wire transport
 * only and has no database/SQL dependency.
 */
export function createAgentFeedApiServer(options: AgentFeedApiOptions): Server {
  const service = resolveService(options);
  const maxBodyBytes = options.max_body_bytes ?? service.security.max_body_bytes;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://agent-feed.local");
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, healthBody(service));
        return;
      }
      if (req.method === "GET" && (url.pathname === "/ready" || url.pathname === "/readiness")) {
        const readiness = await service.readiness();
        writeJson(res, readiness.ok ? 200 : 503, readiness);
        return;
      }

      const principal: ProducerPrincipal = service.authenticate(principalRequest(req));
      service.assertRateAllowed(principal);

      if (req.method === "GET") {
        const findingMatch = /^\/v1\/runs\/([^/]+)\/findings$/u.exec(url.pathname);
        if (findingMatch) {
          const findings = await service.getFindings(decodedRunId(findingMatch[1]!), principal);
          writeJson(res, 200, { run_id: decodedRunId(findingMatch[1]!), findings });
          return;
        }
        const runMatch = /^\/v1\/runs\/([^/]+)$/u.exec(url.pathname);
        if (runMatch) {
          const run = await service.getRun(decodedRunId(runMatch[1]!), principal);
          writeJson(res, 200, run);
          return;
        }
      }

      if (req.method === "POST") {
        const body = await readJson(req, maxBodyBytes);
        if (url.pathname === "/v1/runs:begin") {
          const run = await service.beginRun(body, principal);
          writeJson(res, 201, run);
          return;
        }
        const batchMatch = /^\/v1\/runs\/([^/]+)\/batches$/u.exec(url.pathname);
        if (batchMatch) {
          const runId = decodedRunId(batchMatch[1]!);
          const run = await service.submitBatch(runId, body, principal);
          writeJson(res, 202, run);
          return;
        }
        const completeMatch = /^\/v1\/runs\/([^/]+):complete$/u.exec(url.pathname);
        if (completeMatch) {
          const runId = decodedRunId(completeMatch[1]!);
          const run = await service.completeRun(runId, body, principal);
          writeJson(res, 200, run);
          return;
        }
      }
      writeJson(res, 404, { error: "not_found" });
    } catch (error) {
      const response = errorResponse(error);
      writeJson(res, response.status, response.body, response.headers);
    }
  });
}
