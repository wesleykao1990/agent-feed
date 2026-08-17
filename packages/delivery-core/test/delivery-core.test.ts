import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundCursorCodec,
  CursorError,
  DeliveryWorker,
  ExponentialRetryPolicy,
  InMemoryMetricsSink,
  assertCursorScope,
  matchesSelector,
  matchesSubscription,
} from "../src/index.ts";
import {
  canonicalJson,
  signRawBody,
  verifyRawBody,
} from "@agent-feed/protocol-runtime";
import type {
  AcknowledgeInput,
  Clock,
  ConsumerSubscription,
  CursorPayload,
  DeliveryClaim,
  DeliveryEndpoint,
  DeliveryError,
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
  NormalizedSubscriptionSelector,
  PullInput,
  PullPage,
  ReplayInput,
  RetryInput,
  SignedDelivery,
} from "../src/index.ts";

const now = new Date("2026-08-18T00:00:00.000Z");

function endpoint(): DeliveryEndpoint {
  return { endpointRef: "endpoint://consumer-a", signingKeyId: "delivery-key-a" };
}

function selector(overrides: Partial<NormalizedSubscriptionSelector> = {}): NormalizedSubscriptionSelector {
  return {
    streamIds: ["stream-a"],
    findingTypes: null,
    routingTags: null,
    eventTypes: ["finding.submitted", "run.completed", "run.failed", "run.partial", "run.started"],
    ...overrides,
  };
}

function subscription(overrides: Partial<ConsumerSubscription> = {}): ConsumerSubscription {
  return {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: 1,
    selectors: selector(),
    activationPosition: "0",
    status: "active",
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
    payload: { finding: { finding_id: "finding-a" } },
    payloadHash: "hash-a",
    findingType: "policy.change",
    routingTags: ["priority", "regional"],
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

class AdvancingClock implements Clock {
  #value: number;
  constructor(value: Date) { this.#value = value.getTime(); }
  now(): Date { return new Date(this.#value); }
  advance(milliseconds: number): void { this.#value += milliseconds; }
}

class FakeSigner implements DeliverySigner {
  readonly calls: Array<{ attempt: number; eventId: string; payloadHash: string }> = [];
  sign(input: {
    event: DeliveryEvent;
    subscription: ConsumerSubscription;
    deliveryId: string;
    attempt: number;
    replayGeneration: number;
    timestampSeconds: number;
  }): SignedDelivery {
    this.calls.push({ attempt: input.attempt, eventId: input.event.eventId, payloadHash: input.event.payloadHash });
    return {
      eventId: input.event.eventId,
      deliveryId: input.deliveryId,
      rawBody: JSON.stringify({ event_id: input.event.eventId, payload_hash: input.event.payloadHash, attempt: input.attempt }),
      signature: `sig-${input.attempt}`,
      timestampSeconds: input.timestampSeconds,
      attempt: input.attempt,
      replayGeneration: input.replayGeneration,
      traceId: input.event.traceId,
      keyId: "delivery-key-a",
      headers: {
        "content-type": "application/json",
        "x-agent-feed-event-id": input.event.eventId,
        "x-agent-feed-delivery-id": input.deliveryId,
        "x-agent-feed-attempt": String(input.attempt),
        "x-agent-feed-protocol-version": input.event.protocolVersion,
        "x-agent-feed-timestamp": String(input.timestampSeconds),
        "x-agent-feed-key-id": "delivery-key-a",
        "x-agent-feed-signature": `sig-${input.attempt}`,
        ...(input.event.traceId === null ? {} : { "x-agent-feed-trace-id": input.event.traceId }),
      },
    };
  }
}

class FakeTransport implements DeliveryTransport {
  readonly requests: DeliveryTransportRequest[] = [];
  response: DeliveryTransportResponse | null = { status: 204 };
  error: Error | null = null;
  onSend: (() => void) | undefined;

  async send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse> {
    this.requests.push(request);
    this.onSend?.();
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

  async recoverExpiredLeases(_input: { now: string; limit: number }): Promise<number> { return this.recoveries; }

  async replay(_input: ReplayInput): Promise<DeliveryJob> {
    return job({ state: "queued", replayGeneration: 1, attempt: 0, leaseToken: null });
  }

  async pull(_input: PullInput): Promise<PullPage> { return { deliveries: [], nextCursor: null }; }
}

function workerFixture(
  response: DeliveryTransportResponse | Error,
  options: { attempt?: number; transitionApplied?: boolean; clock?: Clock; batchSize?: number } = {},
) {
  const repository = new FakeRepository();
  repository.transitionApplied = options.transitionApplied ?? true;
  repository.claims = [{ job: job({ attempt: options.attempt ?? 1 }), event: event(), subscription: subscription() }];
  const transport = new FakeTransport();
  if (response instanceof Error) transport.error = response;
  else transport.response = response;
  const signer = new FakeSigner();
  const metrics = new InMemoryMetricsSink({ allowedLabelKeys: ["event_type"], maxSeries: 20 });
  const worker = new DeliveryWorker({
    repository,
    transport,
    signer,
    clock: options.clock ?? new FixedClock(now),
    metrics,
    workerId: "worker-a",
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    retryPolicy: new ExponentialRetryPolicy({ maxAttempts: 3, baseDelaySeconds: 5, maxDelaySeconds: 30 }),
  });
  return { worker, repository, transport, signer, metrics };
}

test("normalized selector supports exact streams, finding-type OR, routing-tag any/all, and event types", () => {
  const finding = event();
  assert.equal(matchesSelector(selector({ findingTypes: ["other", "policy.change"] }), finding), true);
  assert.equal(matchesSelector(selector({ findingTypes: ["other"] }), finding), false);
  assert.equal(matchesSelector(selector({ routingTags: { mode: "any", values: ["other", "regional"] } }), finding), true);
  assert.equal(matchesSelector(selector({ routingTags: { mode: "all", values: ["priority", "regional"] } }), finding), true);
  assert.equal(matchesSelector(selector({ routingTags: { mode: "all", values: ["priority", "other"] } }), finding), false);
  assert.equal(matchesSelector(selector({ eventTypes: ["run.completed"] }), finding), false);
  assert.equal(matchesSelector(selector({ streamIds: ["stream-other"] }), finding), false);

  const terminal = event({ eventType: "run.completed", findingId: null, findingType: null, routingTags: [] });
  assert.equal(matchesSelector(selector({ eventTypes: ["run.completed"], findingTypes: ["never"] }), terminal), true);
  assert.throws(() => matchesSelector(selector({ streamIds: [] }), finding), /invalid_selector_stream_ids/);
});
test("subscription matching enforces tenant, active state, quarantine, and future-only activation", () => {
  const sub = subscription();
  assert.equal(matchesSubscription(event({ sequence: "1" }), sub), true);
  assert.equal(matchesSubscription(event({ sequence: "0" }), sub), false);
  assert.equal(matchesSubscription(event({ sequence: "10" }), subscription({ activationPosition: "10" })), false);
  assert.equal(matchesSubscription(event({ sequence: "11" }), subscription({ activationPosition: "10" })), true);
  assert.equal(matchesSubscription(event({ tenantId: "tenant-b" }), sub), false);
  assert.equal(matchesSubscription(event({ deliveryEligible: false }), sub), false);
  assert.equal(matchesSubscription(event(), subscription({ status: "paused" })), false);
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

test("HMAC cursor uses runtime canonical JSON/signature ports and rejects tamper, expiry, and wrong scope", () => {
  const secret = "test-cursor-secret";
  const codec = new BoundCursorCodec({
    canonicalize: (payload) => canonicalJson(payload),
    signer: {
      sign: (payload) => signRawBody(payload, 0, secret),
      verify: (payload, signature) => verifyRawBody(payload, 0, signature, secret, { nowSeconds: 0 }),
    },
    nowSeconds: () => 1_999,
  });
  const claims: CursorPayload = {
    version: 1,
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: 2,
    position: "10",
    expiresAt: 2_000,
  };
  const token = codec.encode(claims);
  assert.equal(token.includes("tenant-a"), false);
  assert.deepEqual(codec.decode(token), claims);
  assert.doesNotThrow(() => assertCursorScope(claims, {
    tenantId: "tenant-a",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: 2,
  }));
  assert.throws(() => assertCursorScope(claims, {
    tenantId: "tenant-b",
    consumerId: "consumer-a",
    subscriptionId: "sub-a",
    selectorVersion: 2,
  }), (error: unknown) => error instanceof CursorError && error.code === "cursor_scope_mismatch");
  assert.throws(() => codec.decode(`${token.slice(0, -1)}x`), (error: unknown) => error instanceof CursorError && error.code === "cursor_signature_mismatch");

  const expired = new BoundCursorCodec({
    canonicalize: (payload) => canonicalJson(payload),
    signer: {
      sign: (payload) => signRawBody(payload, 0, secret),
      verify: (payload, signature) => verifyRawBody(payload, 0, signature, secret, { nowSeconds: 0 }),
    },
    nowSeconds: () => 2_000,
  });
  assert.throws(() => expired.decode(token), (error: unknown) => error instanceof CursorError && error.code === "cursor_expired");
});

test("worker acknowledges a signed 2xx delivery and propagates stable identity and trace headers", async () => {
  const fixture = workerFixture({ status: 204 });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["acknowledged"]);
  assert.equal(fixture.repository.acknowledgements.length, 1);
  assert.equal(fixture.repository.acknowledgements[0]?.status, 204);
  const request = fixture.transport.requests[0];
  assert.ok(request);
  assert.equal(request.headers["x-agent-feed-event-id"], "evt_12345678");
  assert.equal(request.headers["x-agent-feed-delivery-id"], "delivery-a");
  assert.equal(request.headers["x-agent-feed-attempt"], "1");
  assert.equal(request.headers["x-agent-feed-trace-id"], "trace-a");
  assert.equal(request.body, request.signed.rawBody);
  assert.equal(fixture.metrics.getCounter("delivery_acknowledged", { event_type: "finding.submitted" }), 1);
  assert.ok(fixture.metrics.getObservations("delivery_latency_seconds", { event_type: "finding.submitted" }).length > 0);
});

test("worker schedules bounded retry and never includes tenant/consumer/subscription IDs in metrics", async () => {
  const fixture = workerFixture({ status: 503, headers: { "retry-after": "600" } });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["retry_scheduled"]);
  assert.equal(fixture.repository.retries[0]?.nextAttemptAt, "2026-08-18T00:00:30.000Z");
  assert.equal(fixture.repository.retries[0]?.error.code, "http_503");
  assert.ok([...Object.keys(fixture.metrics.snapshot().counters), ...Object.keys(fixture.metrics.snapshot().observations)].every((key) => !key.includes("tenant-a") && !key.includes("consumer-a") && !key.includes("sub-a")));
});

test("worker refreshes outcome time after a slow webhook before retry mutation", async () => {
  const clock = new AdvancingClock(now);
  const fixture = workerFixture({ status: 503 }, { clock });
  fixture.transport.onSend = () => clock.advance(120_000);
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["retry_scheduled"]);
  assert.equal(fixture.repository.retries[0]?.now, "2026-08-18T00:02:00.000Z");
  assert.equal(fixture.repository.retries[0]?.nextAttemptAt, "2026-08-18T00:02:05.000Z");
  assert.ok(fixture.repository.retries[0]?.now > "2026-08-18T00:01:00.000Z", "lease mutation uses post-transport time");
});

test("worker refreshes time independently for each slow delivery in a batch", async () => {
  const clock = new AdvancingClock(now);
  const fixture = workerFixture({ status: 204 }, { clock, batchSize: 2 });
  const first = fixture.repository.claims[0];
  assert.ok(first);
  fixture.repository.claims = [
    first,
    {
      job: job({ deliveryId: "delivery-b", subscriptionId: "sub-b", eventId: "evt_87654321", traceId: "trace-b", leaseToken: "lease-b" }),
      event: event({ eventId: "evt_87654321", traceId: "trace-b" }),
      subscription: subscription({ subscriptionId: "sub-b" }),
    },
  ];
  fixture.transport.onSend = () => clock.advance(60_000);
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["acknowledged", "acknowledged"]);
  assert.deepEqual(fixture.repository.acknowledgements.map((ack) => ack.now), [
    "2026-08-18T00:01:00.000Z",
    "2026-08-18T00:02:00.000Z",
  ]);
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

test("worker stale lease outcome cannot mutate newer repository state", async () => {
  const fixture = workerFixture({ status: 204 }, { transitionApplied: false });
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["stale_lease"]);
  assert.equal(fixture.metrics.getCounter("delivery_stale_outcome", { event_type: "finding.submitted" }), 1);
});

test("crash/reclaim retry changes attempt envelope but preserves source identity and payload hash", async () => {
  const fixture = workerFixture({ status: 204 });
  await fixture.worker.runOnce();
  fixture.repository.claims = [{
    job: job({ attempt: 2, leaseToken: "lease-b" }),
    event: event(),
    subscription: subscription(),
  }];
  await fixture.worker.runOnce();
  assert.deepEqual(fixture.signer.calls, [
    { attempt: 1, eventId: "evt_12345678", payloadHash: "hash-a" },
    { attempt: 2, eventId: "evt_12345678", payloadHash: "hash-a" },
  ]);
  assert.notEqual(fixture.transport.requests[0]?.body, fixture.transport.requests[1]?.body);
  assert.equal(fixture.transport.requests[1]?.headers["x-agent-feed-attempt"], "2");
});

test("worker rejects missing endpoint and signer identity mismatch as dead-letterable configuration errors", async () => {
  const missing = workerFixture({ status: 204 });
  missing.repository.claims[0] = { job: job(), event: event(), subscription: subscription({ endpoint: null }) };
  assert.deepEqual((await missing.worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(missing.repository.deadLetters[0]?.error.code, "delivery_endpoint_missing");

  const repository = new FakeRepository();
  repository.claims = [{ job: job(), event: event(), subscription: subscription() }];
  const signer: DeliverySigner = {
    sign: () => ({
      eventId: "wrong-event",
      deliveryId: "delivery-a",
      rawBody: "{}",
      signature: "signature",
      timestampSeconds: 1,
      attempt: 1,
      replayGeneration: 0,
      traceId: "trace-a",
      keyId: "delivery-key-a",
      headers: {},
    }),
  };
  const worker = new DeliveryWorker({ repository, transport: new FakeTransport(), signer, clock: new FixedClock(now), workerId: "worker-a" });
  assert.deepEqual((await worker.runOnce()).items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(repository.deadLetters[0]?.error.code, "signing_error");
  assert.equal(repository.deadLetters[0]?.error.message, "delivery signing failed");
  assert.equal(new FakeTransport().requests.length, 0);
});

test("worker rejects claim identity mismatches before signing or network I/O", async () => {
  const mismatched = workerFixture({ status: 204 });
  const original = mismatched.repository.claims[0];
  assert.ok(original);
  mismatched.repository.claims[0] = {
    ...original,
    job: job({ eventId: "wrong-event", traceId: "trace-a" }),
    event: event(),
    subscription: subscription(),
  };
  const result = await mismatched.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(mismatched.transport.requests.length, 0);
  assert.equal(mismatched.signer.calls.length, 0);
  assert.equal(mismatched.repository.deadLetters[0]?.error.code, "claim_identity_mismatch");
  assert.equal(mismatched.repository.deadLetters[0]?.error.message, "delivery claim identity mismatch");

  const wrongScope = workerFixture({ status: 204 });
  const scopeClaim = wrongScope.repository.claims[0];
  assert.ok(scopeClaim);
  wrongScope.repository.claims[0] = {
    ...scopeClaim,
    subscription: subscription({ consumerId: "consumer-other" }),
  };
  await wrongScope.worker.runOnce();
  assert.equal(wrongScope.transport.requests.length, 0);
  assert.equal(wrongScope.repository.deadLetters[0]?.error.code, "claim_identity_mismatch");
});

test("worker rejects unsafe or overridden signed headers before network I/O", async () => {
  const repository = new FakeRepository();
  repository.claims = [{ job: job(), event: event(), subscription: subscription() }];
  const transport = new FakeTransport();
  const signer: DeliverySigner = {
    sign(input) {
      const valid = new FakeSigner().sign(input);
      return {
        ...valid,
        headers: {
          ...valid.headers,
          "x-agent-feed-attempt": "999",
          "X-Agent-Feed-Event-Id": `${input.event.eventId}\r\nX-Injected: yes`,
        },
      };
    },
  };
  const worker = new DeliveryWorker({ repository, transport, signer, clock: new FixedClock(now), workerId: "worker-a" });
  const result = await worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(transport.requests.length, 0);
  assert.equal(repository.deadLetters[0]?.error.code, "signing_error");
  assert.equal(repository.deadLetters[0]?.error.message, "delivery signing failed");
});

test("worker rejects transport-controlled header overrides before network I/O", async () => {
  const repository = new FakeRepository();
  repository.claims = [{ job: job(), event: event(), subscription: subscription() }];
  const transport = new FakeTransport();
  const signer: DeliverySigner = {
    sign(input) {
      const valid = new FakeSigner().sign(input);
      return { ...valid, headers: { ...valid.headers, host: "attacker.example" } };
    },
  };
  const worker = new DeliveryWorker({ repository, transport, signer, clock: new FixedClock(now), workerId: "worker-a" });
  const result = await worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["dead_lettered"]);
  assert.equal(transport.requests.length, 0);
  assert.equal(repository.deadLetters[0]?.error.code, "signing_error");
});

test("worker persists redacted transport errors rather than injected exception text", async () => {
  const fixture = workerFixture(new Error("secret=top-secret endpoint=https://internal.example.test/sql"));
  const result = await fixture.worker.runOnce();
  assert.deepEqual(result.items.map((item) => item.outcome), ["retry_scheduled"]);
  const error = fixture.repository.retries[0]?.error;
  assert.equal(error?.code, "network_error");
  assert.equal(error?.message, "webhook transport failed");
  assert.equal(error?.message.includes("top-secret"), false);
  assert.equal(error?.message.includes("internal.example.test"), false);
});

test("bounded metrics sink collapses unknown labels and remains within its series limit", () => {
  const metrics = new InMemoryMetricsSink({ maxSeries: 3, allowedLabelKeys: ["event_type"] });
  for (let index = 0; index < 20; index += 1) metrics.increment("delivery", 1, { event_type: `unbounded-${index}` });
  assert.ok(metrics.snapshot().seriesCount <= 3);
});

test("bounded metrics sink caps retained observation samples per series", () => {
  const metrics = new InMemoryMetricsSink({ maxSeries: 3, maxObservationSamplesPerSeries: 2 });
  metrics.observe("latency", 1);
  metrics.observe("latency", 2);
  metrics.observe("latency", 3);
  assert.deepEqual(metrics.getObservations("latency"), [2, 3]);
  assert.throws(() => new InMemoryMetricsSink({ maxObservationSamplesPerSeries: 0 }), /invalid_metric_observation_limit/);
});
