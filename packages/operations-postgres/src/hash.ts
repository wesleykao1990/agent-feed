import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key]!)]));
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function jsonHash(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}
