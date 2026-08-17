import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { AgentFeedStore } from "./store.ts";
import {
  enforceBatchLimits,
  enforceEvidenceSecurity,
  enforceFindingSecurity,
  legacyTokenAuthenticator,
  ProducerRateLimiter,
  resolveSecurityPolicy,
  SecurityError,
  SECURITY_DEFAULTS,
  StaticProducerAuthenticator,
  type ProducerAuthenticator,
  type ProducerCredential,
  type ProducerPrincipal,
  type RateLimitOptions,
  type SecurityPolicy,
} from "./security.ts";
import type { RunRecord } from "./types.ts";
import { RunBundleImporter } from "./wire.ts";

export interface AgentFeedServerOptions {
  store?: AgentFeedStore;
  /** Legacy single-token mode retained for local-file/REST compatibility. */
  token?: string;
  credentials?: readonly ProducerCredential[];
  authenticator?: ProducerAuthenticator;
  rateLimiter?: ProducerRateLimiter;
  rateLimit?: RateLimitOptions;
  security?: Partial<SecurityPolicy>;
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(json)),
    ...headers,
  });
  res.end(json);
}

async function rawBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new SecurityError("body_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new SecurityError("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function errorCode(error: unknown): string {
  if (error instanceof SecurityError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "invalid_json") return "invalid_json";
  if (message === "body_too_large") return "body_too_large";
  if (message.startsWith("schema_validation_failed")) return "schema_validation_failed";
  if (message.includes("secret_bearing_evidence_rejected")) return "secret_bearing_evidence_rejected";
  if (message.includes("secret_field_rejected")) return "secret_field_rejected";
  if (message.includes("personal_data_rejected")) return "personal_data_rejected";
  if (message.includes("evidence_excerpt_too_large")) return "evidence_excerpt_too_large";
  if (message.includes("evidence_metadata_too_large")) return "evidence_metadata_too_large";
  if (message.includes("batch_limit_exceeded")) return "batch_limit_exceeded";
  if (message.includes("idempotency_payload_conflict")) return "idempotency_payload_conflict";
  if (message.includes("run_id_conflict")) return "run_id_conflict";
  if (message.includes("terminal_run_immutable")) return "terminal_run_immutable";
  if (message.includes("run_not_found")) return "run_not_found";
  return message;
}

function statusFor(error: unknown): number {
  if (error instanceof SecurityError) return error.status;
  const code = errorCode(error);
  if (code === "body_too_large" || code === "batch_limit_exceeded" || code === "evidence_excerpt_too_large" || code === "evidence_metadata_too_large") return 413;
  if (code === "schema_validation_failed" || code === "invalid_json" || code === "secret_bearing_evidence_rejected" || code === "secret_field_rejected" || code === "personal_data_rejected") return 422;
  if (code === "idempotency_payload_conflict" || code === "run_id_conflict" || code === "terminal_run_immutable") return 409;
  if (code === "run_not_found") return 404;
  if (code === "unauthorized_stream" || code === "unauthorized_producer") return 403;
  return 400;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bodyStreamId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  return (
    stringValue(value.streamId) ??
    stringValue(value.stream_id) ??
    (value.begin && typeof value.begin === "object"
      ? stringValue((value.begin as Record<string, unknown>).stream_id) ?? stringValue((value.begin as Record<string, unknown>).streamId)
      : null)
  );
}

function bodyProducerId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const producer = value.producer;
  return (
    stringValue(value.producerId) ??
    stringValue(value.producer_id) ??
    (producer && typeof producer === "object"
      ? stringValue((producer as Record<string, unknown>).producer_id) ?? stringValue((producer as Record<string, unknown>).producerId)
      : null) ??
    (value.begin && typeof value.begin === "object"
      ? bodyProducerId((value.begin as Record<string, unknown>).producer)
      : null)
  );
}

function bodyRunId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  return stringValue(value.runId) ?? stringValue(value.run_id);
}

function streamAllowed(principal: ProducerPrincipal, streamId: string): boolean {
  return principal.allowedStreamIds.includes("*") || principal.allowedStreamIds.includes(streamId);
}

function authorizeStream(principal: ProducerPrincipal, streamId: string | null): void {
  if (!streamId) return;
  if (!streamAllowed(principal, streamId)) throw new SecurityError("unauthorized_stream");
}

function authorizeProducer(principal: ProducerPrincipal, producerId: string | null): void {
  if (!producerId || principal.producerId === "*") return;
  if (principal.producerId !== producerId) throw new SecurityError("unauthorized_producer");
}

function authorizeRun(principal: ProducerPrincipal, run: RunRecord): void {
  authorizeStream(principal, run.streamId);
  authorizeProducer(principal, run.producerId);
}

function enforceDirectBodySecurity(body: unknown, policy: SecurityPolicy, runId?: string): void {
  if (!body || typeof body !== "object") return;
  const value = body as Record<string, unknown>;
  const findings = Array.isArray(value.findings) ? value.findings : [];
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  enforceBatchLimits(findings, evidence, policy);
  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const handling = record.handling;
    const handlingRecord = handling && typeof handling === "object" ? handling as Record<string, unknown> : undefined;
    const evidenceSecurityRecord: Parameters<typeof enforceEvidenceSecurity>[0] = {
      ...record,
      excerpt: typeof record.excerpt === "string" ? record.excerpt : null,
      handling: {
        containsSecrets: handlingRecord?.containsSecrets === true || handlingRecord?.contains_secrets === true,
        containsPersonalData: handlingRecord?.containsPersonalData === true || handlingRecord?.contains_personal_data === true,
      },
    };
    const evidenceId = stringValue(record.evidenceId) ?? stringValue(record.evidence_id);
    if (evidenceId !== null) evidenceSecurityRecord.evidenceId = evidenceId;
    enforceEvidenceSecurity(
      evidenceSecurityRecord,
      policy,
      runId === undefined ? {} : { runId },
    );
  }
  for (const item of findings) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const flags = Array.isArray(record.securityFlags)
      ? record.securityFlags.filter((flag): flag is string => typeof flag === "string")
      : Array.isArray(record.security_flags)
        ? record.security_flags.filter((flag): flag is string => typeof flag === "string")
        : [];
    const findingSecurityRecord: Parameters<typeof enforceFindingSecurity>[0] = {
      ...record,
      securityFlags: flags,
    };
    const findingId = stringValue(record.findingId) ?? stringValue(record.finding_id);
    if (findingId !== null) findingSecurityRecord.findingId = findingId;
    enforceFindingSecurity(
      findingSecurityRecord,
      policy,
      runId === undefined ? {} : { runId },
    );
  }
}

export function createAgentFeedServer(options: AgentFeedServerOptions = {}): Server {
  const security = resolveSecurityPolicy(options.security);
  // A store supplied by a caller owns its own policy. For a prototype-created
  // store, pass the limits/rejection settings but leave quarantine callbacks to
  // the ingress preflight so each payload emits one hook event.
  const store = options.store ?? new AgentFeedStore({
    security: {
      maxBodyBytes: security.maxBodyBytes,
      maxFindingsPerBatch: security.maxFindingsPerBatch,
      maxEvidencePerBatch: security.maxEvidencePerBatch,
      maxEvidenceExcerptCharacters: security.maxEvidenceExcerptCharacters,
      maxEvidenceMetadataBytes: security.maxEvidenceMetadataBytes,
      rejectSecrets: security.rejectSecrets,
      rejectPersonalData: security.rejectPersonalData,
      quarantinePersonalData: false,
      quarantineHostileFindings: false,
    },
  });
  const importer = new RunBundleImporter(store, { security });
  const token = options.token ?? process.env.AGENT_FEED_PROTOTYPE_TOKEN ?? "prototype-only-token";
  if (options.authenticator && options.credentials) throw new Error("choose_authenticator_or_credentials");
  const authenticator = options.authenticator ?? (
    options.credentials ? new StaticProducerAuthenticator(options.credentials) : legacyTokenAuthenticator(token)
  );
  const limiter = options.rateLimiter ?? new ProducerRateLimiter(options.rateLimit);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://agent-feed.local");
      if (req.method === "GET" && url.pathname === "/health") {
        return reply(res, 200, {
          ok: true,
          service: "agent-feed-prototype",
          protocolVersion: "0.1",
          security: SECURITY_DEFAULTS_PUBLIC(security, limiter),
        });
      }

      const authenticationRequest = req.headers.authorization === undefined
        ? {}
        : { authorization: req.headers.authorization };
      const principal = authenticator.authenticate(authenticationRequest);
      if (!principal) {
        throw new SecurityError("unauthorized");
      }
      limiter.assertAllowed(principal.producerId);

      if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
        let runId: string;
        try {
          runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        } catch {
          throw new Error("invalid_run_id");
        }
        const run = store.getRun(runId);
        if (!run) return reply(res, 404, { error: "run_not_found" });
        authorizeRun(principal, run);
        return reply(res, 200, run);
      }

      const raw = await rawBody(req, security.maxBodyBytes);
      const body = parseJson(raw);
      if (req.method === "POST" && url.pathname === "/import-run-bundle") {
        authorizeStream(principal, bodyStreamId(body));
        authorizeProducer(principal, bodyProducerId(body));
        const result = importer.import(body);
        return reply(res, result.imported ? 201 : 200, result);
      }

      if (req.method === "POST" && url.pathname === "/begin-run") {
        authorizeStream(principal, bodyStreamId(body));
        authorizeProducer(principal, bodyProducerId(body));
        enforceDirectBodySecurity(body, security);
        const value = body as Record<string, unknown>;
        return reply(res, 201, store.beginRun(value as Parameters<AgentFeedStore["beginRun"]>[0]));
      }
      if (req.method === "POST" && url.pathname === "/submit-batch") {
        const run = bodyRunId(body) ? store.getRun(bodyRunId(body)!) : null;
        if (run) authorizeRun(principal, run);
        enforceDirectBodySecurity(body, security, bodyRunId(body) ?? undefined);
        const value = body as Record<string, unknown>;
        return reply(res, 202, store.submitBatch(value as Parameters<AgentFeedStore["submitBatch"]>[0]));
      }
      if (req.method === "POST" && url.pathname === "/complete-run") {
        const run = bodyRunId(body) ? store.getRun(bodyRunId(body)!) : null;
        if (run) authorizeRun(principal, run);
        const value = body as Record<string, unknown>;
        return reply(res, 200, store.completeRun(value as Parameters<AgentFeedStore["completeRun"]>[0]));
      }
      if (req.method === "POST" && url.pathname === "/expectations") {
        authorizeStream(principal, bodyStreamId(body));
        enforceDirectBodySecurity(body, security);
        const value = body as Record<string, unknown>;
        return reply(res, 201, store.registerExpectation(value as Parameters<AgentFeedStore["registerExpectation"]>[0]));
      }
      if (req.method === "POST" && url.pathname === "/liveness") {
        const requestedStream = bodyStreamId(body);
        authorizeStream(principal, requestedStream);
        const value = body as Record<string, unknown>;
        const results = store.evaluateLiveness(String(value.now ?? new Date().toISOString()));
        const filtered = results.filter((result) => streamAllowed(principal, result.streamId));
        return reply(res, 200, filtered);
      }
      return reply(res, 404, { error: "not_found" });
    } catch (error) {
      const status = statusFor(error);
      const headers: Record<string, string> = {};
      if (status === 401) headers["www-authenticate"] = "Bearer";
      if (error instanceof SecurityError && error.retryAfterSeconds !== null) {
        headers["retry-after"] = String(error.retryAfterSeconds);
      }
      return reply(res, status, { error: errorCode(error) }, headers);
    }
  });
}

function SECURITY_DEFAULTS_PUBLIC(security: SecurityPolicy, limiter: ProducerRateLimiter): Record<string, unknown> {
  return {
    algorithm: SECURITY_DEFAULTS.algorithm,
    replayWindowSeconds: SECURITY_DEFAULTS.replayWindowSeconds,
    maxBodyBytes: security.maxBodyBytes,
    maxFindingsPerBatch: security.maxFindingsPerBatch,
    maxEvidencePerBatch: security.maxEvidencePerBatch,
    maxEvidenceExcerptCharacters: security.maxEvidenceExcerptCharacters,
    maxEvidenceMetadataBytes: security.maxEvidenceMetadataBytes,
    producerRequestsPerMinute: limiter.maxRequestsPerMinute,
    producerBurst: limiter.burst,
    producerBurstWindowMs: limiter.burstWindowMs,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAgentFeedServer();
  server.listen(Number(process.env.PORT ?? 7071), "127.0.0.1", () => {
    console.log("Agent Feed prototype: http://127.0.0.1:7071");
  });
}
