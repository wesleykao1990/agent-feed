import { canonicalJson, sha256Hex } from "./canonical.ts";
import { MAX_AUDIT_EXPORT_BYTES, MAX_AUDIT_EXPORT_RECORDS, type AuditExport, type AuditExportRequest, type AuditRecord, type AuditRecordType, type JsonObject } from "./types.ts";

const AUDIT_SCHEMA_VERSION = "agent-feed.audit-export.v1" as const;

function parseIso(value: string, field: string): number {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`invalid_${field}`);
  return Date.parse(value);
}

function validateType(value: string): value is AuditRecordType {
  return ["run", "batch", "finding", "evidence", "outbox_event", "delivery", "delivery_attempt", "liveness_incident", "managed_artifact", "retention", "operator_action"].includes(value);
}

const FORBIDDEN_DETAIL_KEY_PARTS = [
  "artifact",
  "authorization",
  "body",
  "content",
  "cookie",
  "credential",
  "excerpt",
  "password",
  "payload",
  "raw",
  "secret",
  "signature",
  "token",
];

const SENSITIVE_VALUE_PATTERNS: readonly { reason: string; pattern: RegExp }[] = [
  { reason: "authorization_scheme", pattern: /\b(?:bearer|basic)\s+\S{8,}/i },
  { reason: "aws_authorization", pattern: /\bAWS4-HMAC-SHA256\b/i },
  { reason: "url_userinfo", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i },
  { reason: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/ },
  { reason: "github_token", pattern: /\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{20,}\b/ },
  { reason: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { reason: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "stripe_api_key", pattern: /\b(?:pk|rk|sk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { reason: "signed_token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
];

const SENSITIVE_QUERY_KEY_PARTS = [
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "signature",
  "token",
];

function decodedVariants(value: string): readonly string[] {
  const variants = [value];
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return variants;
}

function hasSensitiveQueryParameter(value: string): boolean {
  const questionMark = value.indexOf("?");
  const query = questionMark >= 0 ? value.slice(questionMark + 1).split("#", 1)[0] ?? "" : value;
  if (!query.includes("=")) return false;
  for (const segment of query.split(/[&;]/)) {
    const rawKey = segment.split("=", 1)[0] ?? "";
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SENSITIVE_QUERY_KEY_PARTS.some((part) => key.includes(part)) || key === "sig" || key.endsWith("sig")) return true;
  }
  return false;
}

function assertSafeText(value: string): void {
  for (const variant of decodedVariants(value)) {
    const match = SENSITIVE_VALUE_PATTERNS.find(({ pattern }) => pattern.test(variant));
    if (match) throw new Error(`audit_sensitive_value:${match.reason}`);
    if (hasSensitiveQueryParameter(variant)) throw new Error("audit_sensitive_value:query_parameter");
  }
}

function assertMetadataOnly(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== "object") throw new Error("invalid_audit_details");
  if (Array.isArray(value)) {
    for (const child of value) {
      if (typeof child === "string") assertSafeText(child);
      if (child && typeof child === "object") assertMetadataOnly(child);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (FORBIDDEN_DETAIL_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
      throw new Error(`audit_sensitive_detail:${key}`);
    }
    if (typeof child === "string") assertSafeText(child);
    if (child && typeof child === "object") assertMetadataOnly(child);
  }
}

function isInScope(record: AuditRecord, request: AuditExportRequest): boolean {
  const scope = request.scope;
  if (record.tenantId !== scope.tenantId) throw new Error("audit_tenant_mismatch");
  if (scope.runIds && (!record.runId || !scope.runIds.includes(record.runId))) return false;
  if (scope.streamIds && (!record.streamId || !scope.streamIds.includes(record.streamId))) return false;
  if (scope.recordTypes && !scope.recordTypes.includes(record.recordType)) return false;
  const occurredMs = parseIso(record.occurredAt, "occurred_at");
  if (scope.from && occurredMs < parseIso(scope.from, "from")) return false;
  if (scope.to && occurredMs > parseIso(scope.to, "to")) return false;
  return true;
}

function stableRecord(record: AuditRecord): JsonObject {
  if (!validateType(record.recordType)) throw new Error(`invalid_record_type:${record.recordType}`);
  if (!record.tenantId || !record.recordId || !record.action) throw new Error("invalid_audit_record");
  parseIso(record.occurredAt, "occurred_at");
  if (record.payloadHash !== null && !/^[a-f0-9]{64}$/i.test(record.payloadHash)) throw new Error("invalid_payload_hash");
  for (const value of [record.tenantId, record.recordId, record.runId, record.streamId, record.action, record.status, record.traceId]) {
    if (value !== null) assertSafeText(value);
  }
  if (record.details) assertMetadataOnly(record.details);
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    tenant_id: record.tenantId,
    record_type: record.recordType,
    record_id: record.recordId,
    run_id: record.runId,
    stream_id: record.streamId,
    occurred_at: new Date(Date.parse(record.occurredAt)).toISOString(),
    action: record.action,
    status: record.status,
    trace_id: record.traceId,
    payload_hash: record.payloadHash,
    ...(record.details ? { details: record.details } : {}),
  };
}

interface NormalizedAuditRecord {
  readonly record: AuditRecord;
  readonly occurredAtMs: number;
  readonly line: string;
}

function normalizeRecord(record: AuditRecord): NormalizedAuditRecord {
  return {
    record,
    occurredAtMs: parseIso(record.occurredAt, "occurred_at"),
    line: canonicalJson(stableRecord(record)),
  };
}

function compareRecords(a: NormalizedAuditRecord, b: NormalizedAuditRecord): number {
  return a.occurredAtMs - b.occurredAtMs
    || a.record.recordType.localeCompare(b.record.recordType)
    || a.record.recordId.localeCompare(b.record.recordId)
    || a.record.action.localeCompare(b.record.action)
    || a.line.localeCompare(b.line);
}

/**
 * Export deterministic, metadata-only NDJSON. Raw finding/evidence payloads
 * are intentionally not accepted by the contract, preventing an operator
 * export from becoming an accidental data exfiltration path.
 */
export function exportAudit(request: AuditExportRequest): AuditExport {
  if (!request.scope.tenantId) throw new Error("invalid_tenant_id");
  if (request.scope.from) parseIso(request.scope.from, "from");
  if (request.scope.to) parseIso(request.scope.to, "to");
  const records = request.records.filter((record) => isInScope(record, request)).map(normalizeRecord).sort(compareRecords);
  if (records.length > MAX_AUDIT_EXPORT_RECORDS) throw new Error("audit_export_record_limit_exceeded");
  const lines: string[] = [];
  let contentBytes = 0;
  for (const record of records) {
    const line = record.line;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    contentBytes += lineBytes;
    if (contentBytes > MAX_AUDIT_EXPORT_BYTES) throw new Error("audit_export_bytes_limit_exceeded");
    lines.push(line);
  }
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    format: "ndjson",
    tenantId: request.scope.tenantId,
    recordCount: records.length,
    firstOccurredAt: records.length === 0 ? null : new Date(records[0]?.occurredAtMs ?? 0).toISOString(),
    lastOccurredAt: records.length === 0 ? null : new Date(records[records.length - 1]?.occurredAtMs ?? 0).toISOString(),
    contentSha256: sha256Hex(content),
    content,
  };
}
