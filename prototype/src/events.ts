import { canonicalJson, signBody, verifyBody } from "./security.ts";
import type { DeliveryEvent, RunRecord, SignedDeliveryEvent } from "./types.ts";

export interface EventSigningOptions {
  /** Unix seconds used in the pinned HMAC input. Pass this in tests. */
  timestampSeconds?: number;
  /** Delivery attempt is part of the signed event body. */
  attempt?: number;
  /** Optional deployment key identifier; the key itself is never serialized. */
  keyId?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("invalid_event_attempt");
  }
}

function terminalEventType(run: RunRecord): Extract<DeliveryEvent["eventType"], `run.${string}`> {
  switch (run.status) {
    case "completed":
      return "run.completed";
    case "partial":
      return "run.partial";
    case "failed":
      return "run.failed";
    case "cancelled":
      // The v0.1 wire enum has no run.cancelled value. Keep the terminal
      // status explicit in payload while using the existing failure channel.
      return "run.failed";
    case "running":
      throw new Error(`run_not_terminal:${run.runId}`);
  }
}

export function findingDeliveryEvent(
  run: RunRecord,
  findingId: string,
  occurredAt: string,
  attempt = 1,
): DeliveryEvent {
  assertAttempt(attempt);
  const finding = run.findings.find((item) => item.findingId === findingId);
  if (!finding) throw new Error(`finding_not_found:${findingId}`);
  return {
    protocolVersion: "0.1",
    eventId: `evt_${run.runId}_${finding.findingId}`,
    eventType: "finding.submitted",
    streamId: run.streamId,
    runId: run.runId,
    findingId: finding.findingId,
    occurredAt,
    attempt,
    payload: {
      finding: clone(finding),
      submittedEvidence: clone(
        run.evidence.filter((evidence) => finding.evidenceRefs.includes(evidence.evidenceId)),
      ),
    },
  };
}

export function terminalDeliveryEvent(
  run: RunRecord,
  occurredAt = run.completedAt ?? run.startedAt,
  attempt = 1,
): DeliveryEvent {
  assertAttempt(attempt);
  if (run.status === "running") throw new Error(`run_not_terminal:${run.runId}`);
  return {
    protocolVersion: "0.1",
    eventId: `evt_${run.runId}_terminal`,
    eventType: terminalEventType(run),
    streamId: run.streamId,
    runId: run.runId,
    findingId: null,
    occurredAt,
    attempt,
    payload: {
      status: run.status,
      completedAt: run.completedAt,
      actualScope: clone(run.actualScope),
      expectedScope: clone(run.expectedScope),
      stats: clone(run.stats),
      findingCount: run.findings.length,
      evidenceCount: run.evidence.length,
      errorSummary: run.errorSummary,
    },
  };
}

/**
 * Sign the canonical event body with the v0.1 `timestamp.body` HMAC input.
 * The returned object contains the event fields for convenient access and the
 * exact body used for verification/delivery. It does not mutate `event`.
 */
export function signDeliveryEvent(
  event: DeliveryEvent,
  secret: string,
  options: EventSigningOptions | number = {},
): SignedDeliveryEvent {
  if (!secret) throw new Error("signing_secret_required");
  const normalizedOptions: EventSigningOptions = typeof options === "number"
    ? { timestampSeconds: options }
    : options;
  const attempt = normalizedOptions.attempt ?? event.attempt;
  assertAttempt(attempt);
  const wireEvent: DeliveryEvent = {
    ...clone(event),
    attempt,
  };
  const rawBody = canonicalJson(wireEvent);
  const timestampSeconds = normalizedOptions.timestampSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestampSeconds)) throw new Error("invalid_event_timestamp");
  const signed: SignedDeliveryEvent = {
    ...wireEvent,
    timestampSeconds,
    signature: signBody(rawBody, timestampSeconds, secret),
    rawBody,
    body: rawBody,
  };
  if (normalizedOptions.keyId !== undefined) signed.keyId = normalizedOptions.keyId;
  return signed;
}

/**
 * Verify both signature metadata and the exact event body. This catches a
 * caller mutating a returned event object after it was signed.
 */
export function verifySignedDeliveryEvent(
  event: SignedDeliveryEvent,
  secret: string,
  nowSeconds?: number,
): boolean {
  const { timestampSeconds, signature, rawBody, body, keyId: _keyId, ...wireEvent } = event;
  void _keyId;
  if (!Number.isSafeInteger(timestampSeconds) || typeof signature !== "string") return false;
  if (body !== rawBody) return false;
  if (canonicalJson(wireEvent) !== rawBody) return false;
  return verifyBody(rawBody, timestampSeconds, signature, secret, nowSeconds);
}
