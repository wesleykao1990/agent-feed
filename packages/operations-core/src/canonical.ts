import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.ts";

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Canonical JSON used for plan IDs and audit hashes. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("json_non_plain_object");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    const child = value[key];
    if (child === undefined) throw new Error("json_undefined");
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  }).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
