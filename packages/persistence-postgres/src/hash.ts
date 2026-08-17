import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";

/**
 * Hash protocol payloads independently of object insertion order. Undefined is
 * rejected because it is not a JSON value and silently dropping it would make
 * two different requests share an idempotency hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") throw new TypeError("payload contains undefined");
  if (typeof value !== "object") throw new TypeError(`payload contains unsupported value: ${typeof value}`);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function payloadHash(value: JsonValue | Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
