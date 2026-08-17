import { createHmac, timingSafeEqual } from "node:crypto";

export const SECURITY_DEFAULTS = Object.freeze({
  algorithm: "hmac-sha256",
  replayWindowSeconds: 300,
  maxBodyBytes: 1024 * 1024,
  maxFindingsPerBatch: 100,
  maxEvidencePerBatch: 100,
  maxEvidenceExcerptCharacters: 5000,
  keyRotationOverlapHours: 24,
  producerRequestsPerMinute: 60,
});

export function signBody(rawBody: string, timestampSeconds: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}

export function verifyBody(
  rawBody: string,
  timestampSeconds: number,
  signatureHex: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (Math.abs(nowSeconds - timestampSeconds) > SECURITY_DEFAULTS.replayWindowSeconds) return false;
  const expected = Buffer.from(signBody(rawBody, timestampSeconds, secret), "hex");
  const received = Buffer.from(signatureHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
