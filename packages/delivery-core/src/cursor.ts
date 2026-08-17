import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CursorCanonicalizer,
  CursorCodec,
  CursorContext,
  CursorPayload,
} from "./types.ts";
import { CursorError } from "./types.ts";

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
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
    || candidate.version !== "0.1"
    || !nonEmpty(candidate.tenantId)
    || !nonEmpty(candidate.consumerId)
    || !nonEmpty(candidate.subscriptionId)
    || !nonEmpty(candidate.selectorVersion)
    || !nonEmpty(candidate.position)
    || !Number.isSafeInteger(candidate.expiresAt)
    || (candidate.expiresAt as number) < 1
  ) {
    throw new CursorError("invalid_cursor_payload");
  }
}

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
}

/** HMAC cursor codec; canonical JSON ownership is injected by the caller. */
export class HmacCursorCodec implements CursorCodec {
  readonly #secret: string;
  readonly #canonicalize: CursorCanonicalizer;

  constructor(secret: string, canonicalize: CursorCanonicalizer) {
    if (!secret) throw new Error("cursor_secret_required");
    this.#secret = secret;
    this.#canonicalize = canonicalize;
  }

  encode(input: Omit<CursorPayload, "version">): string {
    const payload: CursorPayload = { version: "0.1", ...input };
    assertPayload(payload);
    const encodedPayload = encodeBase64Url(this.#canonicalize(payload));
    return `${encodedPayload}.${encodeBase64Url(signature(this.#secret, encodedPayload))}`;
  }

  decode(token: string, context: CursorContext): CursorPayload {
    if (!Number.isSafeInteger(context.nowSeconds) || context.nowSeconds < 0) throw new CursorError("invalid_cursor");
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new CursorError("invalid_cursor");
    const encodedPayload = parts[0];
    const encodedSignature = parts[1];
    if (encodedPayload === undefined || encodedSignature === undefined) throw new CursorError("invalid_cursor");
    const provided = decodeBase64Url(encodedSignature);
    const expected = signature(this.#secret, encodedPayload);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new CursorError("cursor_signature_mismatch");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as unknown;
    } catch {
      throw new CursorError("invalid_cursor_payload");
    }
    assertPayload(parsed);
    if (this.#canonicalize(parsed) !== decodeBase64Url(encodedPayload).toString("utf8")) {
      throw new CursorError("invalid_cursor_payload");
    }
    if (
      parsed.tenantId !== context.tenantId
      || parsed.consumerId !== context.consumerId
      || parsed.subscriptionId !== context.subscriptionId
      || parsed.selectorVersion !== context.selectorVersion
    ) {
      throw new CursorError("cursor_binding_mismatch");
    }
    if (context.nowSeconds >= parsed.expiresAt) throw new CursorError("cursor_expired");
    return parsed;
  }
}
