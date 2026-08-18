import { createHash } from "node:crypto";

/**
 * The SQLite example uses the same canonical JSON rule as the protocol
 * runtime: object keys are sorted, arrays keep their order, and unsupported
 * values fail closed instead of being silently dropped by JSON.stringify.
 */
export function canonicalJson(value) {
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

  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("json_non_plain_object");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function payloadHash(value) {
  return sha256Hex(canonicalJson(value));
}

export function jsonText(value) {
  // Validate with the same representation used for hashes before persistence.
  canonicalJson(value);
  return JSON.stringify(value);
}

export function parseJson(text, field) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid persisted ${field} JSON`, { cause: error });
  }
}
