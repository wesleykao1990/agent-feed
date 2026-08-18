import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ProducerServiceError,
  type ProducerPrincipal,
  type RateLimitDecision,
  type RunRecord,
} from "@agent-feed/producer-service";
import type { ProducerService } from "@agent-feed/producer-service";

type HeaderValue = string | readonly string[] | undefined;
type HeadersLike = Readonly<Record<string, HeaderValue>>;
type RequestBody = string | Uint8Array | AsyncIterable<Uint8Array | string>;

export interface RestRequest {
  method: string;
  path: string;
  headers?: HeadersLike;
  body?: RequestBody;
}

export interface RestResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

/**
 * The adapter accepts the public ProducerService boundary structurally. This
 * keeps transport tests free of SQL while allowing the production composition
 * root to inject the real service instance.
 */
export interface RestProducerService {
  readonly security: {
    readonly max_body_bytes: number;
    readonly max_findings_per_batch?: number;
    readonly max_evidence_per_batch?: number;
    readonly max_evidence_excerpt_characters?: number;
  };
  readonly rate_limiter?: {
    readonly max_requests_per_minute: number;
    readonly burst: number;
    readonly burst_window_ms: number;
  };
  authenticate(request: { authorization?: string }): ProducerPrincipal;
  assertRateAllowed(principal: ProducerPrincipal): RateLimitDecision;
  beginRun(value: unknown, principal: ProducerPrincipal): Promise<RunRecord>;
  submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord>;
  completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord>;
  getRun(runId: string, principal: ProducerPrincipal): Promise<RunRecord>;
  getFindings(runId: string, principal: ProducerPrincipal): Promise<RunRecord["findings"]>;
  readiness?(): Promise<{ ok: boolean; checked_at: string }>;
}

export interface RestAdapterOptions {
  service: RestProducerService;
  /** Defaults to the service's security policy. */
  max_body_bytes?: number;
  /** Compatibility label for composition roots that expose a named API. */
  service_name?: string;
}

function header(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === "string" ? value : value[0];
  }
  return undefined;
}

function contentType(headers: HeadersLike | undefined): string | undefined {
  return header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

function errorResponse(error: unknown): RestResponse {
  if (error instanceof ProducerServiceError) {
    const responseHeaders: Record<string, string> = {};
    if (error.status === 401) responseHeaders["www-authenticate"] = "Bearer";
    if (error.retry_after_seconds !== null) responseHeaders["retry-after"] = String(error.retry_after_seconds);
    return { status: error.status, headers: responseHeaders, body: { error: error.code } };
  }
  // Never expose an injected persistence/transport message, stack, payload,
  // authorization value, or evidence excerpt at a public boundary.
  return { status: 503, headers: {}, body: { error: "storage_error" } };
}

function invalidInput(message: string): ProducerServiceError {
  return new ProducerServiceError("invalid_input", message);
}

function bodyTooLarge(): ProducerServiceError {
  return new ProducerServiceError("body_too_large", "request body exceeds the configured limit");
}

async function bodyBytes(body: RequestBody | undefined, maxBytes: number): Promise<Uint8Array> {
  if (body === undefined) throw new ProducerServiceError("invalid_json", "request body must contain JSON");
  if (typeof body === "string") {
    const result = Buffer.from(body, "utf8");
    if (result.byteLength > maxBytes) throw bodyTooLarge();
    return result;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw bodyTooLarge();
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += bytes.byteLength;
    if (size > maxBytes) throw bodyTooLarge();
    chunks.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function jsonBody(request: RestRequest, maxBytes: number): Promise<unknown> {
  if (contentType(request.headers) !== "application/json") {
    throw new ProducerServiceError("unsupported_media_type", "content-type must be application/json");
  }
  const declaredLength = header(request.headers, "content-length");
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw invalidInput("content-length is invalid");
    if (length > maxBytes) throw bodyTooLarge();
  }
  const bytes = await bodyBytes(request.body, maxBytes);
  if (bytes.byteLength === 0) throw new ProducerServiceError("invalid_json", "request body must contain JSON");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProducerServiceError("invalid_json", "request body is not valid JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProducerServiceError("invalid_json", "request body is not valid JSON");
  }
}

function decodedRunId(pathPart: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    throw invalidInput("run_id is not valid URL encoding");
  }
  // SDKs encode the entire wire ID as one path segment. A decoded slash is
  // therefore valid identifier data when it came from `%2F`; a literal slash
  // never reaches this helper because the route regex treats it as a segment
  // boundary.
  if (decoded.length === 0) throw invalidInput("run_id is invalid");
  return decoded;
}

function healthBody(service: RestProducerService, serviceName: string): Record<string, unknown> {
  const security: Record<string, unknown> = {
    max_body_bytes: service.security.max_body_bytes,
  };
  if (service.security.max_findings_per_batch !== undefined) security.max_findings_per_batch = service.security.max_findings_per_batch;
  if (service.security.max_evidence_per_batch !== undefined) security.max_evidence_per_batch = service.security.max_evidence_per_batch;
  if (service.security.max_evidence_excerpt_characters !== undefined) security.max_evidence_excerpt_characters = service.security.max_evidence_excerpt_characters;
  if (service.rate_limiter) {
    security.producer_requests_per_minute = service.rate_limiter.max_requests_per_minute;
    security.producer_burst = service.rate_limiter.burst;
    security.producer_burst_window_ms = service.rate_limiter.burst_window_ms;
  }
  return {
    ok: true,
    service: serviceName,
    protocol_version: "0.1",
    security,
  };
}

/** Map one transport-neutral request into the shared producer application service. */
export async function handleRestRequest(request: RestRequest, options: RestAdapterOptions): Promise<RestResponse> {
  const service = options.service;
  const maxBytes = options.max_body_bytes ?? service.security.max_body_bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_body_bytes");
  try {
    const url = new URL(request.path, "http://agent-feed.local");
    const method = request.method.toUpperCase();
    if (method === "GET" && url.pathname === "/health") {
      return { status: 200, headers: {}, body: healthBody(service, options.service_name ?? "agent-feed-rest-adapter") };
    }
    if (method === "GET" && (url.pathname === "/ready" || url.pathname === "/readiness")) {
      if (!service.readiness) return { status: 200, headers: {}, body: { ok: true, checked_at: new Date().toISOString() } };
      const readiness = await service.readiness();
      return { status: readiness.ok ? 200 : 503, headers: {}, body: readiness };
    }

    const authorization = header(request.headers, "authorization");
    const principal = service.authenticate(authorization === undefined ? {} : { authorization });
    service.assertRateAllowed(principal);

    if (method === "GET") {
      const findingsMatch = /^\/v1\/runs\/([^/]+)\/findings$/u.exec(url.pathname);
      if (findingsMatch) {
        const runId = decodedRunId(findingsMatch[1]!);
        const findings = await service.getFindings(runId, principal);
        return { status: 200, headers: {}, body: { run_id: runId, findings } };
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/u.exec(url.pathname);
      if (runMatch) {
        const run = await service.getRun(decodedRunId(runMatch[1]!), principal);
        return { status: 200, headers: {}, body: run };
      }
    }

    if (method === "POST") {
      const body = await jsonBody(request, maxBytes);
      if (url.pathname === "/v1/runs:begin") {
        return { status: 201, headers: {}, body: await service.beginRun(body, principal) };
      }
      const batchMatch = /^\/v1\/runs\/([^/]+)\/batches$/u.exec(url.pathname);
      if (batchMatch) {
        const runId = decodedRunId(batchMatch[1]!);
        return { status: 202, headers: {}, body: await service.submitBatch(runId, body, principal) };
      }
      const completeMatch = /^\/v1\/runs\/([^/]+):complete$/u.exec(url.pathname);
      if (completeMatch) {
        const runId = decodedRunId(completeMatch[1]!);
        return { status: 200, headers: {}, body: await service.completeRun(runId, body, principal) };
      }
    }
    return { status: 404, headers: {}, body: { error: "not_found" } };
  } catch (error) {
    return errorResponse(error);
  }
}

function nodeHeaders(request: IncomingMessage): HeadersLike {
  return request.headers;
}

async function nodeRequest(request: IncomingMessage): Promise<RestRequest> {
  return {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: nodeHeaders(request),
    body: request,
  };
}

function writeResponse(response: ServerResponse, result: RestResponse): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    ...result.headers,
  });
  response.end(body);
}

/** Node HTTP composition root; lifecycle policy remains in ProducerService. */
export function createRestServer(options: RestAdapterOptions): Server {
  const maxBytes = options.max_body_bytes ?? options.service.security.max_body_bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_body_bytes");
  return createServer(async (request, response) => {
    const result = await handleRestRequest(await nodeRequest(request), options);
    // Drain a request body even when media/size validation rejected it. This
    // keeps keep-alive sockets reusable and avoids an unread producer stream
    // becoming a transport-level resource leak.
    request.resume();
    writeResponse(response, result);
  });
}

/** Class form is convenient for runtimes that own their HTTP server lifecycle. */
export class RestProducerAdapter {
  readonly service: RestProducerService;
  readonly max_body_bytes: number;
  readonly service_name: string;

  constructor(options: RestAdapterOptions) {
    const maxBytes = options.max_body_bytes ?? options.service.security.max_body_bytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_body_bytes");
    this.service = options.service;
    this.max_body_bytes = maxBytes;
    this.service_name = options.service_name ?? "agent-feed-rest-adapter";
  }

  handle(request: RestRequest): Promise<RestResponse> {
    return handleRestRequest(request, { service: this.service, max_body_bytes: this.max_body_bytes, service_name: this.service_name });
  }

  server(): Server {
    return createRestServer({ service: this.service, max_body_bytes: this.max_body_bytes, service_name: this.service_name });
  }
}

export const createAgentFeedRestServer = createRestServer;
export const createAgentFeedApiServer = createRestServer;
export type { ProducerService };
