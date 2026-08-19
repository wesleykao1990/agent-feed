import type { AuditSourceRecord, JsonObject, JsonValue } from "./types.ts";

const FORBIDDEN_DETAIL_KEY = /^artifact(?:_|$)/iu;
const SENSITIVE_DETAIL_KEY = /(?:secret|token|password|authorization|cookie|credential|private[_-]?key|api[_-]?key)/iu;

function mapValue(value: JsonValue, depth: number): JsonValue {
  if (depth > 8) return "<redacted-depth>";
  if (Array.isArray(value)) return value.map((entry) => mapValue(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DETAIL_KEY.test(key) || SENSITIVE_DETAIL_KEY.test(key)) continue;
    output[key] = mapValue(child, depth + 1);
  }
  return output;
}

/**
 * Adapt PostgreSQL metadata for operations-core.  Operations-core deliberately
 * rejects `artifact*` detail keys and secret-bearing metadata; artifact
 * identity remains available in the typed `sourceId`/`sourceType` fields.
 */
export function mapAuditSourceForOperationsCore(record: AuditSourceRecord): AuditSourceRecord {
  return { ...record, metadata: mapValue(record.metadata, 0) as JsonObject };
}

export function mapAuditSourcesForOperationsCore(records: readonly AuditSourceRecord[]): AuditSourceRecord[] {
  return records.map(mapAuditSourceForOperationsCore);
}
