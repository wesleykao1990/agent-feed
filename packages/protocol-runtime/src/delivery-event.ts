import { canonicalJson, type JsonObject } from "./canonical-json.ts";
import { signRawBody } from "./crypto.ts";
import { KeyRing } from "./key-ring.ts";

export const PROTOCOL_VERSION = "0.1" as const;

export type DeliveryEventType =
  | "run.started"
  | "finding.submitted"
  | "run.completed"
  | "run.partial"
  | "run.failed";

export interface DeliveryEventWire {
  protocol_version: typeof PROTOCOL_VERSION;
  event_id: string;
  event_type: DeliveryEventType;
  stream_id: string;
  run_id: string;
  finding_id: string | null;
  occurred_at: string;
  attempt: number;
  payload: JsonObject;
}

export interface DeliverySigningOptions {
  deliveryId: string;
  timestampSeconds?: number;
  keyId?: string;
  traceId?: string;
  traceparent?: string;
  tracestate?: string;
}

export interface SignedDelivery {
  event: DeliveryEventWire;
  rawBody: string;
  keyId: string;
  timestampSeconds: number;
  signature: string;
  headers: Readonly<Record<string, string>>;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.started",
  "finding.submitted",
  "run.completed",
  "run.partial",
  "run.failed",
]);

const EVENT_KEYS = [
  "attempt",
  "event_id",
  "event_type",
  "finding_id",
  "occurred_at",
  "payload",
  "protocol_version",
  "run_id",
  "stream_id",
] as const;

function assertSafeHeaderValue(value: string, field: string): void {
  if (value.length === 0 || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new TypeError(`invalid_${field}`);
  }
}

function assertTimestampSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid_timestamp_seconds");
}

function assertDateTime(value: string): void {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!rfc3339.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError("invalid_occurred_at");
}

function assertTraceId(value: string): void {
  if (!/^[0-9a-f]{32}$/u.test(value) || /^0{32}$/u.test(value)) throw new TypeError("invalid_trace_id");
}

function assertTraceparent(value: string): void {
  if (!/^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(value)) {
    throw new TypeError("invalid_traceparent");
  }
}

function assertEvent(event: DeliveryEventWire): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("invalid_delivery_event");
  }
  if (event.protocol_version !== PROTOCOL_VERSION) throw new TypeError("unsupported_protocol_version");
  const keys = Object.keys(event).sort();
  const expected = [...EVENT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("delivery_event_has_unknown_fields");
  }
  if (typeof event.event_id !== "string") throw new TypeError("invalid_event_id");
  assertSafeHeaderValue(event.event_id, "event_id");
  if (event.event_id.length < 8) throw new TypeError("event_id_too_short");
  if (typeof event.event_type !== "string") throw new TypeError("invalid_event_type");
  if (!EVENT_TYPES.has(event.event_type)) throw new TypeError("invalid_event_type");
  if (typeof event.stream_id !== "string") throw new TypeError("invalid_stream_id");
  assertSafeHeaderValue(event.stream_id, "stream_id");
  if (typeof event.run_id !== "string") throw new TypeError("invalid_run_id");
  assertSafeHeaderValue(event.run_id, "run_id");
  if (event.finding_id !== null) {
    if (typeof event.finding_id !== "string") throw new TypeError("invalid_finding_id");
    assertSafeHeaderValue(event.finding_id, "finding_id");
  }
  if (typeof event.occurred_at !== "string") throw new TypeError("invalid_occurred_at");
  assertDateTime(event.occurred_at);
  if (!Number.isSafeInteger(event.attempt) || event.attempt < 1) throw new TypeError("invalid_event_attempt");
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new TypeError("invalid_event_payload");
  }
}

/** Encode exactly the strict protocol-0.1 event body, with no transport metadata. */
export function encodeDeliveryEvent(event: DeliveryEventWire): string {
  assertEvent(event);
  return canonicalJson({
    protocol_version: event.protocol_version,
    event_id: event.event_id,
    event_type: event.event_type,
    stream_id: event.stream_id,
    run_id: event.run_id,
    finding_id: event.finding_id,
    occurred_at: event.occurred_at,
    attempt: event.attempt,
    payload: event.payload,
  });
}

/** Parse and require a canonical event body; no reserialization ambiguity is allowed. */
export function decodeDeliveryEvent(rawBody: string): DeliveryEventWire {
  if (rawBody.length === 0) throw new TypeError("empty_event_body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new TypeError("invalid_event_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("invalid_event_body");
  }
  const event = parsed as DeliveryEventWire;
  const canonical = encodeDeliveryEvent(event);
  if (canonical !== rawBody) throw new TypeError("event_body_not_canonical");
  return event;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return found?.[1];
}

function requiredHeader(headers: Record<string, string>, name: string): string {
  const value = header(headers, name);
  if (value === undefined) throw new TypeError(`missing_${name.replaceAll("-", "_")}`);
  return value;
}

function parseIntegerHeader(value: string, field: string): number {
  if (!/^\d+$/u.test(value)) throw new TypeError(`invalid_${field}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`invalid_${field}`);
  return parsed;
}

/**
 * Sign the exact encoded event body. Signature metadata is returned only as
 * transport headers and is never inserted into the strict event JSON.
 */
export function signDeliveryEvent(
  event: DeliveryEventWire,
  keyRing: KeyRing,
  options: DeliverySigningOptions,
): SignedDelivery {
  assertEvent(event);
  assertSafeHeaderValue(options.deliveryId, "delivery_id");
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  assertTimestampSeconds(timestampSeconds);
  if (options.traceId !== undefined) {
    assertTraceId(options.traceId);
  }
  if (options.traceparent !== undefined) {
    assertTraceparent(options.traceparent);
    if (options.traceId !== undefined && options.traceparent.split("-")[1] !== options.traceId) {
      throw new TypeError("traceparent_trace_id_mismatch");
    }
  }
  if (options.tracestate !== undefined) {
    assertSafeHeaderValue(options.tracestate, "tracestate");
  }
  const key = keyRing.getForSigning(timestampSeconds, options.keyId);
  const rawBody = encodeDeliveryEvent(event);
  const rawSignature = signRawBody(rawBody, timestampSeconds, key.secret);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-agent-feed-event-id": event.event_id,
    "x-agent-feed-delivery-id": options.deliveryId,
    "x-agent-feed-attempt": String(event.attempt),
    "x-agent-feed-protocol-version": event.protocol_version,
    "x-agent-feed-timestamp": String(timestampSeconds),
    "x-agent-feed-key-id": key.keyId,
    "x-agent-feed-signature": rawSignature,
  };
  if (options.traceId !== undefined) headers["x-agent-feed-trace-id"] = options.traceId;
  if (options.traceparent !== undefined) headers.traceparent = options.traceparent;
  if (options.tracestate !== undefined) headers.tracestate = options.tracestate;
  return {
    event,
    rawBody,
    keyId: key.keyId,
    timestampSeconds,
    signature: rawSignature,
    headers,
  };
}

/** Verify headers and the exact canonical body using the consumer key ring. */
export function verifySignedDelivery(
  rawBody: string,
  headers: Record<string, string>,
  keyRing: KeyRing,
  options: { nowSeconds?: number; replayWindowSeconds?: number } = {},
): boolean {
  try {
    const event = decodeDeliveryEvent(rawBody);
    const eventId = requiredHeader(headers, "x-agent-feed-event-id");
    const deliveryId = requiredHeader(headers, "x-agent-feed-delivery-id");
    const attempt = parseIntegerHeader(requiredHeader(headers, "x-agent-feed-attempt"), "event_attempt");
    const protocolVersion = requiredHeader(headers, "x-agent-feed-protocol-version");
    const timestampSeconds = parseIntegerHeader(requiredHeader(headers, "x-agent-feed-timestamp"), "timestamp_seconds");
    const keyId = requiredHeader(headers, "x-agent-feed-key-id");
    const signature = requiredHeader(headers, "x-agent-feed-signature");
    if (eventId !== event.event_id || attempt !== event.attempt || protocolVersion !== event.protocol_version) return false;
    assertSafeHeaderValue(deliveryId, "delivery_id");
    const traceId = header(headers, "x-agent-feed-trace-id");
    if (traceId !== undefined) assertTraceId(traceId);
    const traceparent = header(headers, "traceparent");
    if (traceparent !== undefined) {
      assertTraceparent(traceparent);
      if (traceId !== undefined && traceparent.split("-")[1] !== traceId) return false;
    }
    return keyRing.verify(rawBody, timestampSeconds, signature, keyId, options);
  } catch {
    return false;
  }
}
