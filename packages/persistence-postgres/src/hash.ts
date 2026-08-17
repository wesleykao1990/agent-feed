import { canonicalJson, sha256Hex } from "@agent-feed/protocol-runtime";
import type { JsonValue } from "./types.ts";

/**
 * Hash protocol payloads independently of object insertion order. Undefined is
 * rejected because it is not a JSON value and silently dropping it would make
 * two different requests share an idempotency hash.
 */
export function payloadHash(value: JsonValue | Record<string, unknown>): string {
  return sha256Hex(canonicalJson(value));
}

export { canonicalJson };
