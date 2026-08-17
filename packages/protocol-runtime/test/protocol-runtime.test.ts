import assert from "node:assert/strict";
import test from "node:test";
import {
  KEY_ROTATION_OVERLAP_SECONDS,
  KeyRing,
  REPLAY_WINDOW_SECONDS,
  canonicalJson,
  decodeDeliveryEvent,
  encodeDeliveryEvent,
  sha256Hex,
  signDeliveryEvent,
  signRawBody,
  verifyRawBody,
  verifySignedDelivery,
  type DeliveryEventWire,
} from "../src/index.ts";

const event: DeliveryEventWire = {
  protocol_version: "0.1",
  event_id: "event_123456",
  event_type: "finding.submitted",
  stream_id: "stream.daily",
  run_id: "run_123456",
  finding_id: "finding_123456",
  occurred_at: "2026-08-18T12:00:00Z",
  attempt: 1,
  payload: {
    finding: {
      finding_id: "finding_123456",
      routing_tags: ["one", "two"],
      summary: "untrusted claim",
    },
  },
};

test("canonical JSON is stable, rejects non-JSON values, and hashes exact bytes", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: "ok" } }), '{"a":{"x":"ok","y":true},"z":1}');
  assert.equal(canonicalJson(["b", { a: 1 }]), '["b",{"a":1}]');
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => canonicalJson({ invalid: undefined }), /json_undefined/);
  assert.throws(() => canonicalJson(Number.NaN), /json_non_finite_number/);
  assert.throws(() => canonicalJson(new Date()), /json_non_plain_object/);
});

test("wire encoder emits only canonical snake_case protocol-0.1 fields", () => {
  const rawBody = encodeDeliveryEvent(event);
  assert.equal(
    rawBody,
    '{"attempt":1,"event_id":"event_123456","event_type":"finding.submitted","finding_id":"finding_123456","occurred_at":"2026-08-18T12:00:00Z","payload":{"finding":{"finding_id":"finding_123456","routing_tags":["one","two"],"summary":"untrusted claim"}},"protocol_version":"0.1","run_id":"run_123456","stream_id":"stream.daily"}',
  );
  assert.deepEqual(decodeDeliveryEvent(rawBody), event);
  assert.throws(() => decodeDeliveryEvent(`${rawBody}\n`), /event_body_not_canonical/);
  assert.throws(() => encodeDeliveryEvent({ ...event, protocolVersion: "0.1" } as unknown as DeliveryEventWire), /unknown_fields/);
  assert.throws(() => encodeDeliveryEvent({ ...event, attempt: 0 }), /invalid_event_attempt/);
});

test("HMAC signing uses timestamp.raw_body and enforces the replay window", () => {
  const rawBody = '{"hello":"world"}';
  const timestampSeconds = 1_000;
  const signature = signRawBody(rawBody, timestampSeconds, "secret");
  assert.equal(verifyRawBody(rawBody, timestampSeconds, signature, "secret", { nowSeconds: timestampSeconds }), true);
  assert.equal(verifyRawBody(rawBody, timestampSeconds, signature, "secret", { nowSeconds: timestampSeconds + REPLAY_WINDOW_SECONDS }), true);
  assert.equal(verifyRawBody(rawBody, timestampSeconds, signature, "secret", { nowSeconds: timestampSeconds + REPLAY_WINDOW_SECONDS + 1 }), false);
  assert.equal(verifyRawBody(`${rawBody} `, timestampSeconds, signature, "secret", { nowSeconds: timestampSeconds }), false);
  assert.equal(verifyRawBody(rawBody, timestampSeconds, signature, "wrong-secret", { nowSeconds: timestampSeconds }), false);
});

test("key rotation retains old verification keys for exactly the overlap window", () => {
  const ring = new KeyRing([{ keyId: "old", secret: "old-secret", activeFrom: 0 }]);
  ring.rotate({ keyId: "new", secret: "new-secret" }, 1_000);
  assert.equal(ring.overlapSeconds, KEY_ROTATION_OVERLAP_SECONDS);
  assert.equal(ring.getForSigning(1_000).keyId, "new");
  assert.equal(ring.describe().find((key) => key.keyId === "old")?.expiresAt, 1_000 + KEY_ROTATION_OVERLAP_SECONDS);
  const rawBody = "{}";
  const oldSignature = signRawBody(rawBody, 1_100, "old-secret");
  assert.equal(ring.verify(rawBody, 1_100, oldSignature, "old", { nowSeconds: 1_100 }), true);
  assert.equal(ring.verify(rawBody, 1_100, oldSignature, "old", { nowSeconds: 1_000 + KEY_ROTATION_OVERLAP_SECONDS }), false);
  assert.equal(ring.verify(rawBody, 1_100, oldSignature, "new", { nowSeconds: 1_100 }), false);
});

test("signed delivery keeps signature metadata outside the strict body", () => {
  const ring = new KeyRing([{ keyId: "delivery-1", secret: "delivery-secret", activeFrom: 0 }]);
  const signed = signDeliveryEvent(event, ring, {
    deliveryId: "delivery_123456",
    timestampSeconds: 2_000,
    traceId: "0123456789abcdef0123456789abcdef",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    tracestate: "vendor=value",
  });
  assert.equal(signed.rawBody, encodeDeliveryEvent(event));
  assert.equal(Object.hasOwn(JSON.parse(signed.rawBody) as object, "signature"), false);
  assert.equal(signed.headers["x-agent-feed-key-id"], "delivery-1");
  assert.equal(signed.headers["x-agent-feed-event-id"], event.event_id);
  assert.equal(signed.headers["x-agent-feed-delivery-id"], "delivery_123456");
  assert.equal(signed.headers["x-agent-feed-attempt"], "1");
  assert.equal(signed.headers["x-agent-feed-protocol-version"], "0.1");
  assert.equal(signed.headers["x-agent-feed-timestamp"], "2000");
  assert.equal(signed.headers["x-agent-feed-trace-id"], "0123456789abcdef0123456789abcdef");
  assert.equal(verifySignedDelivery(signed.rawBody, signed.headers, ring, { nowSeconds: 2_100 }), true);
  assert.equal(verifySignedDelivery(`${signed.rawBody} `, signed.headers, ring, { nowSeconds: 2_100 }), false);
  assert.equal(verifySignedDelivery(signed.rawBody, { ...signed.headers, "x-agent-feed-event-id": "other_event" }, ring, { nowSeconds: 2_100 }), false);
  assert.equal(verifySignedDelivery(signed.rawBody, { ...signed.headers, "x-agent-feed-signature": "0".repeat(64) }, ring, { nowSeconds: 2_100 }), false);
  assert.equal(verifySignedDelivery(signed.rawBody, {
    ...signed.headers,
    traceparent: "00-abcdefabcdefabcdefabcdefabcdefab-0123456789abcdef-01",
  }, ring, { nowSeconds: 2_100 }), false);
});
