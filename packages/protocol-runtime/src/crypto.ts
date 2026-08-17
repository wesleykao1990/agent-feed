import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./canonical-json.ts";

export const REPLAY_WINDOW_SECONDS = 300;

function assertTimestampSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid_timestamp_seconds");
}

function assertReplayWindow(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid_replay_window_seconds");
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** HMAC-SHA256 over the pinned `timestamp.body` input. */
export function signRawBody(rawBody: string, timestampSeconds: number, secret: string): string {
  assertTimestampSeconds(timestampSeconds);
  if (secret.length === 0) throw new TypeError("signing_secret_required");
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}

/** Backwards-compatible name for callers that already use the M1 primitive. */
export const signBody = signRawBody;

export interface VerifyRawBodyOptions {
  nowSeconds?: number;
  replayWindowSeconds?: number;
}

export function verifyRawBody(
  rawBody: string,
  timestampSeconds: number,
  signatureHex: string,
  secret: string,
  options: VerifyRawBodyOptions = {},
): boolean {
  const nowSeconds = options.nowSeconds ?? nowUnixSeconds();
  const replayWindowSeconds = options.replayWindowSeconds ?? REPLAY_WINDOW_SECONDS;
  try {
    assertTimestampSeconds(timestampSeconds);
    assertTimestampSeconds(nowSeconds);
    assertReplayWindow(replayWindowSeconds);
  } catch {
    return false;
  }
  if (secret.length === 0 || !/^[0-9a-f]{64}$/iu.test(signatureHex)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > replayWindowSeconds) return false;

  const expected = Buffer.from(signRawBody(rawBody, timestampSeconds, secret), "hex");
  const presented = Buffer.from(signatureHex, "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/** Backwards-compatible name for callers that already use the M1 primitive. */
export const verifyBody = (
  rawBody: string,
  timestampSeconds: number,
  signatureHex: string,
  secret: string,
  nowSeconds?: number,
): boolean => verifyRawBody(
  rawBody,
  timestampSeconds,
  signatureHex,
  secret,
  nowSeconds === undefined ? {} : { nowSeconds },
);

export { sha256Hex };
