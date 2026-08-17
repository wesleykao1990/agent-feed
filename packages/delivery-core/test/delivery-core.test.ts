import assert from "node:assert/strict";
import test from "node:test";
import {
  CursorError,
  DeliveryWorker,
  ExponentialRetryPolicy,
  HmacCursorCodec,
  InMemoryMetricsSink,
  matchesSubscription,
  selectorFields,
} from "../src/index.ts";
import type {
  AcknowledgeInput,
  Clock,
  ConsumerSubscription,
  DeliveryClaim,
  DeliveryEndpoint,
  DeliveryEvent,
  DeliveryError,
  DeliveryJob,
  DeliveryRepository,
  DeliverySigner,
  DeliveryTransport,
  DeliveryTransportRequest,
  DeliveryTransportResponse,
  LeaseClaimInput,
  LeaseTransitionResult,
  RetryInput,
  SignedDelivery,
  DeadLetterInput,
  ReplayInput,
  PullInput,
  PullPage,
} from "../src/index.ts";

const now = new Date("2026-08-18T00:00:00.000Z");

function endpoint(): DeliveryEndpoint {
  return { url: "https://consumer.example.test/agent-feed", secretRef: "secret://consumer/key" };
}

function subscription(overrides: Partial<ConsumerSubscription> = {}): ConsumerSubscription {
  return {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    streamIds: [],
    findingTypes: [],
    routingTags: [],
    includeRunEvents: true,
    active: true,
    endpoint: endpoint(),
    ...overrides,
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
    traceId: "trace-a",
    payload: {
      finding: {
        finding_type: "rewards.change",
        routing_tags: ["rewards", "japan"],
      },
    },
    payloadHash: "hash-a",
    deliveryEligible: true,
    ...overrides,
  };
}

function job(overrides: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    deliveryId: "delivery-a",
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    eventId: "evt_12345678",
    traceId: "trace-a",
    state: "leased",
    attempt: 1,
    replayGeneration: 0,
    nextAttemptAt: now.toISOString(),
    leaseToken: "lease-a",
    leaseExpiresAt: "2026-08-18T00:01:00.000Z",
    acknowledgedAt: null,
    deadLetteredAt: null,
    lastError: null,
    ...overrides,
  };
}

class FixedClock implements Clock {
  readonly value: Date;
  constructor(value: Date) { this.value = value; }
  now(): Date { return new Date(this.value.getTime()); }
}

class FakeSigner implements DeliverySigner {
  readonly calls: Array<{ attempt: number; eventId: string; payloadHash: string }> = [];
  sign(input: {
    event: DeliveryEvent;
    subscription: ConsumerSubscription;
    attempt: number;
    replayGeneration: number;
    timestampSeconds: number;
  }): SignedDelivery {
    this.calls.push({ attempt: input.attempt, eventId: input.event.eventId, payloadHash: input.event.payloadHash });
    return {
      eventId: input.event.eventId,
      body: JSON.stringify({ event_id: input.event.eventId, payload_hash: input.event.payloadHash }),
      signature: `sig-${input.attempt}`,
      timestampSeconds: input.timestampSeconds,
      attempt: input.attempt,
      replayGeneration: input.replayGeneration,
      traceId: input.event.traceId,
    };
  }
}

class FakeTransport implements DeliveryTransport {
  readonly requests: DeliveryTransportRequest[] = [];
  response: DeliveryTransportResponse | null = { status: 204 };
  error: Error | null = null;

  async send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse> {
    this.requests.push(request);
    if (this.error) throw this.error;
    if (!this.response) throw new Error("response_not_configured");
    return this.response;
  }
}

class FakeRepository implements DeliveryRepository {
  claims: DeliveryClaim[] = [];
  acknowledgements: AcknowledgeInput[] = [];
  retries: RetryInput[] = [];
  deadLetters: DeadLetterInput[] = [];
  appended: DeliveryEvent[] = [];
  recoveries = 0;
  transitionApplied = true;

  async appendOutboxEvent(eventValue: DeliveryEvent): Promise<void> { this.appended.push(eventValue); }

  async claimDue(_input: LeaseClaimInput): Promise<readonly DeliveryClaim[]> {
    const current = [...this.claims];
    this.claims = [];
    return current;
  }

  #result(jobValue: DeliveryJob): LeaseTransitionResult {
    return this.transitionApplied
      ? { applied: true, job: jobValue }
      : { applied: false, reason: "stale_lease", job: jobValue };
  }

  async acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult> {
    this.acknowledgements.push(input);
    return this.#result(job());
  }

  async scheduleRetry(input: RetryInput): Promise<LeaseTransitionResult> {
    this.retries.push(input);
    return this.#result(job({ state: "retry_wait", nextAttemptAt: input.nextAttemptAt, lastError: input.error }));
  }

  async deadLetter(input: DeadLetterInput): Promise<LeaseTransitionResult> {
    this.deadLetters.push(input);
    return this.#result(job({ state: "dead_letter", deadLetteredAt: input.now, lastError: input.error }));
  }

  async recoverExpiredLeases(_input: { now: string; limit: number }): Promise<number> {
    return this.recoveries;
  }

  async replay(_input: ReplayInput): Promise<DeliveryJob> {
    return job({ state: "queued", replayGeneration: 1, attempt: 0, leaseToken: null });
  }

  async pull(_input: PullInput): Promise<PullPage> {
    return { deliveries: [], nextCursor: null };
  }
}

function workerFixture(response: DeliveryTransportResponse | Error, options: { attempt?: number; transitionApplied?: boolean } = {}) {
  const repository = new FakeRepository();
  repository.transitionApplied = options.transitionApplied ?? true;
  repository.claims = [{
    job: job({ attempt: options.attempt ?? 1 }),
    event: event(),
    subscription: subscription(),
  }];
  const transport = new FakeTransport();
  if (response instanceof Error) transport.error = response;
  else transport.response = response;
  const signer = new FakeSigner();
  const metrics = new InMemoryMetricsSink({
    allowedLabelKeys: ["event_type", "consumer"],
    maxSeries: 20,
  });
  const worker = new DeliveryWorker({
    repository,
    transport,
    signer,
    clock: new FixedClock(now),
    metrics,
    workerId: "worker-a",
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    retryPolicy: new ExponentialRetryPolicy({ maxAttempts: 3, baseDelaySeconds: 5, maxDelaySeconds: 30 }),
  });
  return { worker, repository, transport, signer, metrics };
}

test("subscription selector isolates tenant and matches stream/type/tag filters", () => {
  const finding = event();
  assert.equal(matchesSubscription(finding, subscription({ findingTypes: ["rewards.change"], routingTags: ["japan"] })), true);
  assert.equal(matchesSubscription(finding, subscription({ findingTypes: ["other.type"] })), false);
  assert.equal(matchesSubscription(finding, subscription({ routingTags: ["other"] })), false);
  assert.equal(matchesSubscription(finding, subscription({ tenantId: "tenant-b" })), false);
  assert.equal(matchesSubscription(finding, subscription({ active: false })), false);
  assert.equal(matchesSubscription(event({ deliveryEligible: false }), subscription()), false);
  assert.deepEqual(selectorFields(finding), {
    findingType: "rewards.change",
    routingTags: ["rewards", "japan"],
  });

  const terminal = event({ findingId: null, eventType: "run.completed", payload: {} });
  assert.equal(matchesSubscription(terminal, subscription({ includeRunEvents: true })), true);
  assert.equal(matchesSubscription(terminal, subscription({ includeRunEvents: false })), false);
});

test("selector reads denormalized fields when present and does not trust unrelated payload fields", () => {
  const value = event({
    findingType: "explicit.type",
    routingTags: ["explicit"],
    payload: { finding: { finding_type: "payload.type", routing_tags: ["payload"] } },
  });
  assert.equal(matchesSubscription(value, subscription({ findingTypes: ["explicit.type"], routingTags: ["explicit"] })), true);
  assert.equal(matchesSubscription(value, subscription({ findingTypes: ["payload.type"] })), false);
});

test("retry policy classifies success, retryable statuses, permanent statuses, and network errors", () => {
  const policy = new ExponentialRetryPolicy({ maxAttempts: 3, baseDelaySeconds: 5, maxDelaySeconds: 30, maxRetryAfterSeconds: 20 });
  assert.deepEqual(policy.classify({ status: 204 }, now), { kind: "success", status: 204 });
  const limited = policy.classify({ status: 429, headers: { "Retry-After": "100" } }, now);
  assert.equal(limited.kind, "retry");
  if (limited.kind === "retry") assert.equal(limited.retryAfterSeconds, 100);
  assert.equal(policy.classify({ status: 408 }, now).kind, "retry");
  assert.equal(policy.classify({ status: 425 }, now).kind, "retry");
  assert.equal(policy.classify({ status: 502 }, now).kind, "retry");
  assert.equal(policy.classify({ status: 400 }, now).kind, "permanent");
  assert.equal(policy.classify({ status: 302 }, now).kind, "permanent");
  const network = policy.classify(new Error("socket closed"), now);
  assert.equal(network.kind, "retry");
  if (network.kind === "retry") assert.equal(network.message, "socket closed");
  assert.equal(policy.delaySeconds(1, { eventId: "e", deliveryId: "d", attempt: 1, replayGeneration: 0 }), 5);
  assert.equal(policy.delaySeconds(2, { eventId: "e", deliveryId: "d", attempt: 2, replayGeneration: 0 }), 10);
  assert.equal(policy.delaySeconds(10, { eventId: "e", deliveryId: "d", attempt: 10, replayGeneration: 0 }), 30);
  assert.equal(policy.delaySeconds(1, { eventId: "e", deliveryId: "d", attempt: 1, replayGeneration: 0 }, 100), 20);
});

test("retry-after HTTP date is bounded and malformed values are ignored", () => {
  const policy = new ExponentialRetryPolicy({ baseDelaySeconds: 5, maxDelaySeconds: 30, maxRetryAfterSeconds: 20 });
  const future = new Date(now.getTime() + 12_000).toUTCString();
  const decision = policy.classify({ status: 503, headers: { "retry-after": future } }, now);
  assert.equal(decision.kind, "retry");
  if (decision.kind === "retry") {
    assert.ok(decision.retryAfterSeconds !== null && decision.retryAfterSeconds > 10);
    assert.equal(policy.delaySeconds(1, { eventId: "e", deliveryId: "d", attempt: 1, replayGeneration: 0 }, decision.retryAfterSeconds), 12);
  }
  const malformed = policy.classify({ status: 503, headers: { "retry-after": "later" } }, now);
  assert.equal(malformed.kind, "retry");
  if (malformed.kind === "retry") assert.equal(policy.delaySeconds(1, { eventId: "e", deliveryId: "d", attempt: 1, replayGeneration: 0 }, malformed.retryAfterSeconds), 5);
});

test("HMAC pull cursors are opaque and bound to tenant, consumer, subscription, selector, position, and expiry", () => {
  const canonicalize = (payload: {
    version: string;
    tenantId: string;
    consumerId: string;
    subscriptionId: string;
    selectorVersion: string;
    position: string;
    expiresAt: number;
  }): string => JSON.stringify({
    version: payload.version,
    tenantId: payload.tenantId,
    consumerId: payload.consumerId,
    subscriptionId: payload.subscriptionId,
    selectorVersion: payload.selectorVersion,
    position: payload.position,
    expiresAt: payload.expiresAt,
  });
  const codec = new HmacCursorCodec("test-cursor-secret", canonicalize);
  const token = codec.encode({
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    position: "10",
    expiresAt: 2_000,
  });
  assert.equal(token.includes("tenant-a"), false);
  assert.deepEqual(codec.decode(token, {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    nowSeconds: 1_999,
  }), {
    version: "0.1",
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    position: "10",
    expiresAt: 2_000,
  });
  assert.throws(() => codec.decode(token, {
    tenantId: "tenant-b",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    nowSeconds: 1_999,
  }), (error: unknown) => error instanceof CursorError && error.code === "cursor_binding_mismatch");
  assert.throws(() => codec.decode(`${token.slice(0, -1)}x`, {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    nowSeconds: 1_999,
  }), (error: unknown) => error instanceof CursorError && error.code === "cursor_signature_mismatch");
  assert.throws(() => codec.decode(token, {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: "selector-1",
    nowSeconds: 2_000,
  }), (error: unknown) => error instanceof CursorError && error.code === "cursor_expired");
});

test("worker acknowledges a signed 2xx delivery and propagates trace/attempt headers", async () => {
  const fixture = workerFixture({ status: 204 });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["acknowledged"]);
  assert.equal(fixture.repository.acknowledgements.length, 1);
  assert.equal(fixture.repository.acknowledgements[0]?.status, 204);
  const request = fixture.transport.requests[0];
  assert.ok(request);
  assert.equal(request.headers["x-agent-feed-event-id"], "evt_12345678");
  assert.equal(request.headers["x-agent-feed-attempt"], "1");
  assert.equal(request.headers["x-agent-feed-trace-id"], "trace-a");
  assert.equal(fixture.metrics.getCounter("delivery_acknowledged", { event_type: "finding.submitted", consumer: "consumer-a" }), 1);
});

test("worker schedules bounded exponential retry for 5xx and preserves event identity", async () => {
  const fixture = workerFixture({ status: 503, headers: { "retry-after": "600" } });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["retry_scheduled"]);
  assert.equal(fixture.repository.retries.length, 1);
  assert.equal(fixture.repository.retries[0]?.nextAttemptAt, "2026-08-18T00:00:30.000Z");
  assert.equal(fixture.repository.retries[0]?.error.code, "http_503");
  assert.deepEqual(fixture.signer.calls, [{ attempt: 1, eventId: "evt_12345678", payloadHash: "hash-a" }]);
});

test("worker dead-letters permanent failures and exhausted retry attempts", async () => {
  const permanent = workerFixture({ status: 401 });
  assert.deepEqual((await permanent.worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(permanent.repository.deadLetters[0]?.error.code, "http_401");

  const exhausted = workerFixture(new Error("socket closed"), { attempt: 3 });
  assert.deepEqual((await exhausted.worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(exhausted.repository.deadLetters[0]?.error.code, "max_attempts_exceeded");
  assert.equal(exhausted.repository.deadLetters[0]?.error.retryable, false);
});

test("stale lease outcomes are reported without claiming acknowledgement", async () => {
  const fixture = workerFixture({ status: 204 }, { transitionApplied: false });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["stale_lease"]);
  assert.equal(fixture.metrics.getCounter("delivery_stale_outcome", { event_type: "finding.submitted", consumer: "consumer-a" }), 1);
});

test("worker recovers expired leases through the repository and never owns queue semantics", async () => {
  const fixture = workerFixture({ status: 204 });
  fixture.repository.recoveries = 2;
  assert.equal(await fixture.worker.recoverExpiredLeases(), 2);
  assert.equal(fixture.metrics.getCounter("delivery_lease_recovered"), 2);
});

test("worker dead-letters missing endpoints and signer identity mismatches", async () => {
  const missing = workerFixture({ status: 204 });
  missing.repository.claims[0] = {
    job: job(),
    event: event(),
    subscription: subscription({ endpoint: null }),
  };
  assert.deepEqual((await missing.worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(missing.repository.deadLetters[0]?.error.code, "delivery_endpoint_missing");

  const repository = new FakeRepository();
  repository.claims = [{ job: job(), event: event(), subscription: subscription() }];
  const signer: DeliverySigner = {
    sign: () => ({
      eventId: "wrong-event",
      body: "{}",
      signature: "signature",
      timestampSeconds: 1,
      attempt: 1,
      replayGeneration: 0,
      traceId: "trace-a",
    }),
  };
  const worker = new DeliveryWorker({
    repository,
    transport: new FakeTransport(),
    signer,
    clock: new FixedClock(now),
    workerId: "worker-a",
  });
  assert.deepEqual((await worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(repository.deadLetters[0]?.error.code, "signing_error");
});

test("bounded metrics collapse unknown series instead of growing without limit", () => {
  const metrics = new InMemoryMetricsSink({
    maxSeries: 3,
    allowedLabelKeys: ["consumer"],
  });
  for (let index = 0; index < 20; index += 1) {
    metrics.increment("delivery", 1, { consumer: `consumer-${index}` });
  }
  assert.ok(metrics.snapshot().seriesCount <= 3);
});
