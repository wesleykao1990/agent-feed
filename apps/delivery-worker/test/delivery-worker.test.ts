import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolDeliverySigner,
  StaticDeliveryKeyResolver,
  WebhookRetryPolicy,
  createDeliveryWorker,
  runDeliveryCycle,
  runDeliveryLoop,
} from "../src/index.ts";
import {
  decodeDeliveryEvent,
  KeyRing,
  verifySignedDelivery,
} from "@agent-feed/protocol-runtime";
import type {
  AcknowledgeInput,
  Clock,
  ConsumerSubscription,
  DeliveryClaim,
  DeliveryEndpoint,
  DeliveryEvent,
  DeliveryJob,
  DeliveryRepository,
  DeliverySigner,
  DeliveryTransport,
  DeliveryTransportRequest,
  DeliveryTransportResponse,
  DeadLetterInput,
  LeaseClaimInput,
  LeaseTransitionResult,
  PullInput,
  PullPage,
  ReplayInput,
  RetryInput,
  SignedDelivery,
} from "@agent-feed/delivery-core";

const timestampSeconds = 1760745600;
const traceId = "0123456789abcdef0123456789abcdef";

function endpoint(): DeliveryEndpoint {
  return { endpointRef: "https://example.test/webhook", signingKeyId: "key-a" };
}

function subscription(): ConsumerSubscription {
  return {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: 1,
    selectors: {
      streamIds: ["stream-a"],
      findingTypes: null,
      routingTags: null,
      eventTypes: ["finding.submitted"],
    },
    activationPosition: "0",
    status: "active",
    endpoint: endpoint(),
  };
}

function event(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    protocolVersion: "0.1",
    eventId: "evt_12345678",
    eventType: "finding.submitted",
    tenantId: "tenant-a",
    streamId: "stream-a",
    runId: "run-a",
    findingId: "finding-a",
    occurredAt: "2026-08-18T00:00:00.000Z",
    sequence: "10",
    traceId,
    payload: { record: { record_id: "record-a", value: 7 } },
    payloadHash: "immutable-payload-hash",
    findingType: "status.change",
    routingTags: ["operations"],
    deliveryEligible: true,
    ...overrides,
  };
}

function signer(): ProtocolDeliverySigner {
  return new ProtocolDeliverySigner({
    keyResolver: new StaticDeliveryKeyResolver(new Map([
      [endpoint().endpointRef, new KeyRing([{ keyId: "key-a", secret: "test-secret", activeFrom: 0 }])],
    ])),
  });
}

function sign(attempt: number): SignedDelivery {
  return signer().sign({
    event: event(),
    subscription: subscription(),
    deliveryId: "del_12345678",
    attempt,
    replayGeneration: 0,
    timestampSeconds,
  });
}

test("maps camelCase event to strict snake_case body and signs exact raw bytes", () => {
  const first = sign(1);
  const second = sign(2);
  const firstWire = decodeDeliveryEvent(first.rawBody);
  const secondWire = decodeDeliveryEvent(second.rawBody);
  assert.deepEqual(firstWire, {
    protocol_version: "0.1",
    event_id: "evt_12345678",
    event_type: "finding.submitted",
    stream_id: "stream-a",
    run_id: "run-a",
    finding_id: "finding-a",
    occurred_at: "2026-08-18T00:00:00.000Z",
    attempt: 1,
    payload: { record: { record_id: "record-a", value: 7 } },
  });
  assert.equal(first.headers["x-agent-feed-attempt"], "1");
  assert.equal(second.headers["x-agent-feed-attempt"], "2");
  assert.equal(first.headers["x-agent-feed-event-id"], firstWire.event_id);
  assert.equal(first.headers["x-agent-feed-delivery-id"], first.deliveryId);
  assert.equal(first.headers["x-agent-feed-protocol-version"], firstWire.protocol_version);
  assert.equal(first.headers["x-agent-feed-timestamp"], String(first.timestampSeconds));
  assert.equal(first.headers["x-agent-feed-key-id"], first.keyId);
  assert.equal(first.headers["x-agent-feed-signature"], first.signature);
  assert.equal(first.headers["x-agent-feed-trace-id"], traceId);
  assert.match(first.headers.traceparent ?? "", new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`, "u"));
  assert.equal(first.headers["x-agent-feed-replay-generation"], undefined);
  assert.equal(firstWire.event_id, first.eventId);
  assert.equal(firstWire.attempt, first.attempt);
  assert.notEqual(first.rawBody, second.rawBody);
  assert.equal(firstWire.event_id, secondWire.event_id);
  assert.equal(firstWire.occurred_at, secondWire.occurred_at);
  assert.deepEqual(firstWire.payload, secondWire.payload);
  assert.equal("payload_hash" in firstWire, false);
  const ring = new KeyRing([{ keyId: "key-a", secret: "test-secret", activeFrom: 0 }]);
  assert.equal(verifySignedDelivery(first.rawBody, { ...first.headers }, ring, { nowSeconds: timestampSeconds }), true);
  assert.equal(verifySignedDelivery(second.rawBody, { ...second.headers }, ring, { nowSeconds: timestampSeconds }), true);
});

test("does not expose key-resolver diagnostics through signing errors", () => {
  const leakingResolver = {
    resolve(): KeyRing {
      throw new Error("secret=top-secret endpoint=https://internal.example.test/key");
    },
  };
  const unsafeSigner = new ProtocolDeliverySigner({ keyResolver: leakingResolver });
  assert.throws(
    () => unsafeSigner.sign({
      event: event(),
      subscription: subscription(),
      deliveryId: "del_12345678",
      attempt: 1,
      replayGeneration: 0,
      timestampSeconds,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "signing_key_unavailable"
      && !error.message.includes("top-secret")
      && !error.message.includes("https://internal.example.test"),
  );
});

test("classifies duplicate-package failure shapes with stable messages", () => {
  const policy = new WebhookRetryPolicy();
  const now = new Date("2026-08-18T00:00:00.000Z");
  const duplicatePackageFailure = {
    code: "request_timeout",
    message: "secret=top-secret endpoint=https://internal.example.test",
    retryable: true,
    status: null,
    retryAfterSeconds: null,
  };
  assert.deepEqual(policy.classify(duplicatePackageFailure, now), {
    kind: "retry",
    code: "request_timeout",
    message: "webhook request timed out",
    status: null,
    retryAfterSeconds: null,
  });
  assert.deepEqual(policy.classify(new Error("secret=top-secret https://internal.example.test"), now), {
    kind: "retry",
    code: "network_error",
    message: "webhook network request failed",
    status: null,
    retryAfterSeconds: null,
  });
});

test("quarantined source events cannot be signed", () => {
  assert.throws(() => signer().sign({
    event: event({ deliveryEligible: false }),
    subscription: subscription(),
    deliveryId: "del_12345678",
    attempt: 1,
    replayGeneration: 0,
    timestampSeconds,
  }), /event_not_delivery_eligible/u);
});

class FixedClock implements Clock {
  now(): Date { return new Date("2026-08-18T00:00:00.000Z"); }
}

function job(): DeliveryJob {
  return {
    deliveryId: "del_12345678",
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    eventId: "evt_12345678",
    traceId,
    state: "leased",
    attempt: 1,
    replayGeneration: 0,
    nextAttemptAt: "2026-08-18T00:00:00.000Z",
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-18T00:01:00.000Z",
    acknowledgedAt: null,
    deadLetteredAt: null,
    lastError: null,
  };
}

class FakeRepository implements DeliveryRepository {
  claim: DeliveryClaim | null = { job: job(), event: event(), subscription: subscription() };
  recoveries = 0;
  acknowledgements: AcknowledgeInput[] = [];

  async appendOutboxEvent(): Promise<void> {}
  async claimDue(_input: LeaseClaimInput): Promise<readonly DeliveryClaim[]> {
    if (!this.claim) return [];
    const value = this.claim;
    this.claim = null;
    return [value];
  }
  async acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult> {
    this.acknowledgements.push(input);
    return { applied: true, job: job() };
  }
  async scheduleRetry(_input: RetryInput): Promise<LeaseTransitionResult> { return { applied: true, job: job() }; }
  async deadLetter(_input: DeadLetterInput): Promise<LeaseTransitionResult> { return { applied: true, job: job() }; }
  async recoverExpiredLeases(_input: { now: string; limit: number }): Promise<number> { this.recoveries += 1; return 1; }
  async replay(_input: ReplayInput): Promise<DeliveryJob> { return job(); }
  async pull(_input: PullInput): Promise<PullPage> { return { deliveries: [], nextCursor: null }; }
}

class FakeTransport implements DeliveryTransport {
  requests: DeliveryTransportRequest[] = [];
  async send(input: DeliveryTransportRequest): Promise<DeliveryTransportResponse> {
    this.requests.push(input);
    return { status: 204 };
  }
}

test("composition runs recovery and one delivery without SQL or network coupling", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  const worker = createDeliveryWorker({
    repository,
    clock: new FixedClock(),
    workerId: "worker-a",
    keyResolver: new StaticDeliveryKeyResolver(new Map([
      [endpoint().endpointRef, new KeyRing([{ keyId: "key-a", secret: "test-secret", activeFrom: 0 }])],
    ])),
    transport,
  });
  const result = await runDeliveryCycle(worker);
  assert.equal(repository.recoveries, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.items[0]!.outcome, "acknowledged");
  assert.equal(repository.acknowledgements.length, 1);
  assert.equal(transport.requests[0]!.body, transport.requests[0]!.signed.rawBody);
});

test("loop stops cleanly on an injected abort", async () => {
  const repository = new FakeRepository();
  const controller = new AbortController();
  const worker = createDeliveryWorker({
    repository,
    clock: new FixedClock(),
    workerId: "worker-loop",
    keyResolver: new StaticDeliveryKeyResolver(new Map([
      [endpoint().endpointRef, new KeyRing([{ keyId: "key-a", secret: "test-secret", activeFrom: 0 }])],
    ])),
    transport: new FakeTransport(),
  });
  let sleeps = 0;
  await runDeliveryLoop(worker, {
    signal: controller.signal,
    intervalMs: 1,
    sleep: async () => { sleeps += 1; controller.abort(); },
  });
  assert.equal(sleeps, 1);
});
