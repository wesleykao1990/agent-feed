import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * Canonical JSON used by Agent Feed hashes and signatures.
 *
 * Object keys are sorted by their Unicode code-unit order, arrays preserve
 * order, and values which are not representable in JSON are rejected rather
 * than silently omitted or coerced. The returned string is the exact string
 * callers must send when it is used as a signed body.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("json_non_finite_number");
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("json_undefined");
    case "bigint":
      throw new TypeError("json_bigint");
    case "function":
    case "symbol":
      throw new TypeError("json_unsupported_value");
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("json_non_plain_object");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

