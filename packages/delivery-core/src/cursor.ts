import type {
  CursorCanonicalizer,
  CursorCodec,
  CursorPayload,
  CursorScope,
  CursorSigner,
} from "./types.ts";
import { CursorError } from "./types.ts";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new CursorError("invalid_cursor");
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertPayload(payload: unknown): asserts payload is CursorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CursorError("invalid_cursor_payload");
  }
  const candidate = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    "version",
    "tenantId",
    "consumerId",
    "subscriptionId",
    "selectorVersion",
    "position",
    "expiresAt",
  ]);
  if (
    Object.keys(candidate).some((key) => !allowedKeys.has(key))
    || candidate.version !== 1
    || !nonEmpty(candidate.tenantId)
    || !nonEmpty(candidate.consumerId)
    || !nonEmpty(candidate.subscriptionId)
    || !Number.isSafeInteger(candidate.selectorVersion)
    || (candidate.selectorVersion as number) < 1
    || !nonEmpty(candidate.position)
    || !/^(0|[1-9][0-9]*)$/u.test(candidate.position)
    || !Number.isSafeInteger(candidate.expiresAt)
    || (candidate.expiresAt as number) < 1
  ) {
    throw new CursorError("invalid_cursor_payload");
  }
}

/**
 * Signed opaque cursor codec. Canonical JSON and HMAC/verification are injected
 * so protocol-runtime remains the repository's single crypto implementation.
 * Base64url is only token framing; the payload remains tamper-evident, not
 * confidential.
 */
export class BoundCursorCodec implements CursorCodec {
  readonly #canonicalize: CursorCanonicalizer;
  readonly #signer: CursorSigner;
  readonly #nowSeconds: () => number;

  constructor(options: {
    canonicalize: CursorCanonicalizer;
    signer: CursorSigner;
    nowSeconds: () => number;
  }) {
    this.#canonicalize = options.canonicalize;
    this.#signer = options.signer;
    this.#nowSeconds = options.nowSeconds;
  }

  encode(claims: CursorPayload): string {
    assertPayload(claims);
    const canonicalPayload = this.#canonicalize(claims);
    const encodedPayload = encodeBase64Url(canonicalPayload);
    return `${encodedPayload}.${this.#signer.sign(canonicalPayload)}`;
  }

  decode(token: string): CursorPayload {
    if (!nonEmpty(token)) throw new CursorError("invalid_cursor");
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new CursorError("invalid_cursor");
    const encodedPayload = parts[0];
    const providedSignature = parts[1];
    if (encodedPayload === undefined || providedSignature === undefined) throw new CursorError("invalid_cursor");
    const canonicalPayload = decodeBase64Url(encodedPayload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalPayload) as unknown;
    } catch {
      throw new CursorError("invalid_cursor_payload");
    }
    assertPayload(parsed);
    if (this.#canonicalize(parsed) !== canonicalPayload) throw new CursorError("invalid_cursor_payload");
    if (!this.#signer.verify(canonicalPayload, providedSignature)) throw new CursorError("cursor_signature_mismatch");
    const nowSeconds = this.#nowSeconds();
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new CursorError("invalid_cursor");
    if (nowSeconds >= parsed.expiresAt) throw new CursorError("cursor_expired");
    return parsed;
  }
}

export function assertCursorScope(claims: CursorPayload, expected: CursorScope): void {
  if (
    claims.tenantId !== expected.tenantId
    || claims.consumerId !== expected.consumerId
    || claims.subscriptionId !== expected.subscriptionId
    || claims.selectorVersion !== expected.selectorVersion
  ) {
    throw new CursorError("cursor_scope_mismatch");
  }
}
