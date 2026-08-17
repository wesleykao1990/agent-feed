import assert from "node:assert/strict";
import test from "node:test";

import {
  KeyRing,
  signDeliveryEvent,
  verifySignedDelivery,
  type DeliveryEventWire,
} from "../../packages/protocol-runtime/src/index.ts";
import {
  DeliveryWorker,
  ExponentialRetryPolicy,
  InMemoryMetricsSink,
  matchesSubscription,
  type AcknowledgeInput,
  type Clock,
  type ConsumerSubscription,
  type DeliveryClaim,
  type DeliveryEndpoint,
  type DeliveryError,
  type DeliveryEvent,
  type DeliveryJob,
  type DeliveryRepository,
  type DeliverySigner,
  type DeliveryTransport,
  type DeliveryTransportRequest,
  type DeliveryTransportResponse,
  type DeadLetterInput,
  type LeaseClaimInput,
  type LeaseTransitionResult,
  type PullInput,
  type PullPage,
  type ReplayInput,
  type RetryInput,
  type SignedDelivery,
} from "../../packages/delivery-core/src/index.ts";
import {
  DeliveryConsumerError,
  DeliveryConsumerRepositoryError,
  DeliveryConsumerService,
  matchesSelector,
  normalizeSelector,
  type AcknowledgeRepositoryResult,
  type ConsumerAuthContext,
  type ConsumerAuthPort,
  type ConsumerScope,
  type CreateSubscriptionRecord,
  type CursorCodec,
  type DeliveryConsumerRepository,
  type DeliveryCursorClaims,
  type DeliveryEventRecord,
  type DeadLetterQuery,
  type DeadLetterRecord,
  type PullPageQuery,
  type PullPageRepositoryResult,
  type ReplayDeadLetterRecord,
  type ReplayRepositoryResult,
  type SubscriptionDeliveryRecord,
  type SubscriptionRecord,
  type UpdateSubscriptionRecord,
} from "../../packages/delivery-consumer/src/index.ts";

const NOW = new Date("2026-08-18T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const TRACE_ID = "0123456789abcdef0123456789abcdef";

function protocolEvent(attempt = 1): DeliveryEventWire {
  return {
    protocol_version: "0.1",
    event_id: "evt_m2_conformance_001",
    event_type: "finding.submitted",
    stream_id: "stream.m2.conformance",
    run_id: "run_m2_conformance_001",
    finding_id: "finding_m2_conformance_001",
    occurred_at: "2026-08-18T00:00:00Z",
    attempt,
    payload: {
      finding: {
        finding_id: "finding_m2_conformance_001",
        finding_type: "monitor.change",
        routing_tags: ["important", "m2"],
        summary: "untrusted synthetic claim",
      },
    },
  };
}

test("M2 protocol signing uses exact snake_case bytes, stable event identity, replay bounds, and key rotation", () => {
  const ring = new KeyRing([{ keyId: "old", secret: "old-secret", activeFrom: 0 }]);
  const first = signDeliveryEvent(protocolEvent(1), ring, {
    deliveryId: "delivery_m2_conformance_001",
    timestampSeconds: NOW_SECONDS,
    traceId: TRACE_ID,
  });
  const body = JSON.parse(first.rawBody) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "attempt",
    "event_id",
    "event_type",
    "finding_id",
    "occurred_at",
    "payload",
    "protocol_version",
    "run_id",
    "stream_id",
  ]);
  assert.equal(Object.keys(body).some((key) => /[A-Z]/u.test(key)), false);
  assert.equal(first.headers["x-agent-feed-attempt"], "1");
  assert.equal(verifySignedDelivery(first.rawBody, first.headers, ring, { nowSeconds: NOW_SECONDS }), true);
  assert.equal(verifySignedDelivery(first.rawBody, first.headers, ring, { nowSeconds: NOW_SECONDS + 300 }), true);
  assert.equal(verifySignedDelivery(first.rawBody, first.headers, ring, { nowSeconds: NOW_SECONDS + 301 }), false);
  assert.equal(verifySignedDelivery(`${first.rawBody} `, first.headers, ring, { nowSeconds: NOW_SECONDS }), false);
  assert.equal(
    verifySignedDelivery(first.rawBody, { ...first.headers, "x-agent-feed-attempt": "2" }, ring, { nowSeconds: NOW_SECONDS }),
    false,
  );

  ring.rotate({ keyId: "new", secret: "new-secret" }, NOW_SECONDS + 1);
  const retry = signDeliveryEvent(protocolEvent(2), ring, {
    deliveryId: "delivery_m2_conformance_001",
    timestampSeconds: NOW_SECONDS + 2,
    traceId: TRACE_ID,
  });
  const retryBody = JSON.parse(retry.rawBody) as Record<string, unknown>;
  assert.equal(retry.event.event_id, first.event.event_id);
  assert.deepEqual(retry.event.payload, first.event.payload);
  assert.equal(retry.event.occurred_at, first.event.occurred_at);
  assert.notEqual(retry.rawBody, first.rawBody, "attempt is part of the signed protocol body");
  assert.equal(retryBody.attempt, 2);
  assert.equal(retry.headers["x-agent-feed-attempt"], "2");
  assert.equal(retry.keyId, "new");
  assert.equal(verifySignedDelivery(first.rawBody, first.headers, ring, { nowSeconds: NOW_SECONDS + 2 }), true);
  assert.equal(verifySignedDelivery(retry.rawBody, retry.headers, ring, { nowSeconds: NOW_SECONDS + 2 }), true);
});

function coreEvent(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    protocolVersion: "0.1",
    eventId: "evt_m2_worker_001",
    eventType: "finding.submitted",
    tenantId: "tenant_a",
    streamId: "stream.m2.worker",
    runId: "run_m2_worker_001",
    findingId: "finding_m2_worker_001",
    occurredAt: "2026-08-18T00:00:00Z",
    sequence: "1",
    traceId: TRACE_ID,
    payload: { finding: { finding_type: "monitor.change", routing_tags: ["important"] } },
    payloadHash: "payload-hash-m2-worker",
    findingType: "monitor.change",
    routingTags: ["important"],
    deliveryEligible: true,
    ...overrides,
  };
}

function coreSubscription(overrides: Partial<ConsumerSubscription> = {}): ConsumerSubscription {
  const endpoint: DeliveryEndpoint = { url: "https://consumer.invalid/agent-feed", secretRef: "secret://m2" };
  const selectors = {
    streamIds: ["stream.m2.worker"],
    findingTypes: null,
    routingTags: null,
    eventTypes: ["run.started", "finding.submitted", "run.completed", "run.partial", "run.failed"] as const,
    ...overrides.selectors,
  };
  return {
    tenantId: "tenant_a",
    consumerId: "consumer_a",
    subscriptionId: "subscription_m2_worker",
    selectorVersion: 1,
    selectors,
    activationPosition: "0",
    status: "active",
    endpoint,
    ...overrides,
  };
}

function coreJob(overrides: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    deliveryId: "delivery_m2_worker_001",
    tenantId: "tenant_a",
    consumerId: "consumer_a",
    subscriptionId: "subscription_m2_worker",
    eventId: "evt_m2_worker_001",
    traceId: TRACE_ID,
    state: "leased",
    attempt: 1,
    replayGeneration: 0,
    nextAttemptAt: NOW.toISOString(),
    leaseToken: "lease-m2-worker",
    leaseExpiresAt: "2026-08-18T00:01:00.000Z",
    acknowledgedAt: null,
    deadLetteredAt: null,
    lastError: null,
    ...overrides,
  };
}

class WorkerRepository implements DeliveryRepository {
  readonly claims: DeliveryClaim[] = [];
  readonly acknowledgements: AcknowledgeInput[] = [];
  readonly retries: RetryInput[] = [];
  readonly deadLetters: DeadLetterInput[] = [];
  recoveries = 0;

  async appendOutboxEvent(): Promise<void> {}

  async claimDue(_input: LeaseClaimInput): Promise<readonly DeliveryClaim[]> {
    // Returning the same claim models an at-least-once redelivery after a
    // worker crash that occurred after the HTTP send and before the ack.
    return this.claims.map((claim) => structuredClone(claim));
  }

  async acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult> {
    this.acknowledgements.push(input);
    return { applied: true, job: coreJob() };
  }

  async scheduleRetry(input: RetryInput): Promise<LeaseTransitionResult> {
    this.retries.push(input);
    return { applied: true, job: coreJob({ state: "retry_wait", nextAttemptAt: input.nextAttemptAt }) };
  }

  async deadLetter(input: DeadLetterInput): Promise<LeaseTransitionResult> {
    this.deadLetters.push(input);
    return { applied: true, job: coreJob({ state: "dead_letter", deadLetteredAt: input.now, lastError: input.error }) };
  }

  async recoverExpiredLeases(): Promise<number> {
    return this.recoveries;
  }

  async replay(_input: ReplayInput): Promise<DeliveryJob> {
    return coreJob({ state: "queued", attempt: 0, replayGeneration: 1, leaseToken: null });
  }

  async pull(_input: PullInput): Promise<PullPage> {
    return { deliveries: [], nextCursor: null };
  }
}

class FixedClock implements Clock {
  now(): Date { return new Date(NOW.getTime()); }
}

class ScriptedTransport implements DeliveryTransport {
  readonly requests: DeliveryTransportRequest[] = [];
  readonly responses: Array<DeliveryTransportResponse | Error>;

  constructor(responses: Array<DeliveryTransportResponse | Error>) {
    this.responses = [...responses];
  }

  async send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse> {
    this.requests.push(request);
    const response = this.responses.shift() ?? { status: 204 };
    if (response instanceof Error) throw response;
    return response;
  }
}

function protocolSigner(): DeliverySigner {
  const ring = new KeyRing([{ keyId: "worker-key", secret: "worker-secret", activeFrom: 0 }]);
  return {
    sign(input): SignedDelivery {
      const event = input.event;
      const signed = signDeliveryEvent({
        protocol_version: "0.1",
        event_id: event.eventId,
        event_type: event.eventType as DeliveryEventWire["event_type"],
        stream_id: event.streamId,
        run_id: event.runId,
        finding_id: event.findingId,
        occurred_at: event.occurredAt,
        attempt: input.attempt,
        payload: event.payload,
      }, ring, {
        deliveryId: input.deliveryId,
        timestampSeconds: input.timestampSeconds,
        traceId: event.traceId ?? undefined,
      });
      return {
        eventId: event.eventId,
        deliveryId: input.deliveryId,
        rawBody: signed.rawBody,
        signature: signed.signature,
        timestampSeconds: signed.timestampSeconds,
        attempt: input.attempt,
        replayGeneration: input.replayGeneration,
        traceId: event.traceId,
        keyId: signed.keyId,
        headers: signed.headers,
      };
    },
  };
}

function workerFixture(responses: Array<DeliveryTransportResponse | Error>) {
  const repository = new WorkerRepository();
  repository.claims.push({ job: coreJob(), event: coreEvent(), subscription: coreSubscription() });
  const transport = new ScriptedTransport(responses);
  const metrics = new InMemoryMetricsSink({
    maxSeries: 4,
    allowedLabelKeys: ["event_type", "consumer"],
  });
  const worker = new DeliveryWorker({
    repository,
    transport,
    signer: protocolSigner(),
    clock: new FixedClock(),
    metrics,
    workerId: "worker-m2-conformance",
    tenantId: "tenant_a",
    consumerId: "consumer_a",
    retryPolicy: new ExponentialRetryPolicy({ maxAttempts: 3, baseDelaySeconds: 5, maxDelaySeconds: 30 }),
  });
  return { repository, transport, metrics, worker };
}

test("worker provides at-least-once duplicate safety with stable event/payload identity and bounded metrics", async () => {
  const fixture = workerFixture([{ status: 204 }, { status: 204 }]);
  const receipts = new Set<string>();
  let sideEffects = 0;
  fixture.transport.send = async (request) => {
    fixture.transport.requests.push(request);
    if (!receipts.has(request.eventId)) {
      receipts.add(request.eventId);
      sideEffects += 1;
    }
    return { status: 204 };
  };
  const first = await fixture.worker.runOnce();
  const second = await fixture.worker.runOnce();
  assert.deepEqual(first.items.map((item) => item.outcome), ["acknowledged"]);
  assert.deepEqual(second.items.map((item) => item.outcome), ["acknowledged"]);
  assert.equal(fixture.transport.requests.length, 2);
  assert.equal(sideEffects, 1, "consumer receipt must deduplicate duplicate event IDs");
  assert.equal(fixture.transport.requests[0]!.eventId, fixture.transport.requests[1]!.eventId);
  assert.equal(fixture.transport.requests[0]!.body, fixture.transport.requests[1]!.body);
  assert.equal(fixture.transport.requests[0]!.headers["x-agent-feed-attempt"], "1");
  assert.equal(fixture.transport.requests[0]!.headers["x-agent-feed-trace-id"], TRACE_ID);
  assert.equal(fixture.metrics.getCounter("delivery_transport_attempt", { event_type: "finding.submitted", consumer: "consumer_a" }), 2);
  assert.ok(fixture.metrics.snapshot().seriesCount <= 4);
});

test("worker preserves event identity while retry body attempt and backoff change deterministically", async () => {
  const fixture = workerFixture([{ status: 503, headers: { "retry-after": "600" } }, { status: 204 }]);
  const first = await fixture.worker.runOnce();
  assert.equal(first.items[0]?.outcome, "retry_scheduled");
  assert.equal(fixture.repository.retries[0]?.nextAttemptAt, "2026-08-18T00:00:30.000Z");

  const original = fixture.repository.claims[0]!;
  fixture.repository.claims[0] = {
    ...original,
    job: coreJob({ attempt: 2, state: "leased", leaseToken: "lease-m2-worker-retry" }),
  };
  const second = await fixture.worker.runOnce();
  assert.equal(second.items[0]?.outcome, "acknowledged");
  assert.equal(fixture.transport.requests.length, 2);
  const firstRequest = fixture.transport.requests[0]!;
  const secondRequest = fixture.transport.requests[1]!;
  assert.equal(firstRequest.eventId, secondRequest.eventId);
  assert.equal(firstRequest.traceId, secondRequest.traceId);
  const firstBody = JSON.parse(firstRequest.body) as Record<string, unknown>;
  const secondBody = JSON.parse(secondRequest.body) as Record<string, unknown>;
  assert.equal(firstBody.attempt, 1);
  assert.equal(secondBody.attempt, 2);
  assert.ok(firstBody.payload);
  assert.equal(JSON.stringify(firstBody.payload), JSON.stringify(secondBody.payload));
  assert.equal(secondRequest.headers["x-agent-feed-attempt"], "2");
});

test("selector contracts enforce tenant, stream, exact event type, finding type, and any/all tag semantics", () => {
  const subscription: ConsumerSubscription = coreSubscription({
    selectors: {
      streamIds: ["stream.m2.worker"],
      findingTypes: ["monitor.change", "monitor.alert"],
      routingTags: { mode: "all", values: ["important", "japan"] },
      eventTypes: ["finding.submitted", "run.completed"],
    },
  });
  assert.equal(matchesSubscription(coreEvent({ routingTags: ["important", "japan"] }), subscription), true);
  assert.equal(matchesSubscription(coreEvent({ tenantId: "tenant_b" }), subscription), false);
  assert.equal(matchesSubscription(coreEvent({ findingType: "other" }), subscription), false);
  assert.equal(matchesSubscription(coreEvent({ routingTags: ["other"] }), subscription), false);
  assert.equal(matchesSubscription(coreEvent({ streamId: "other.stream" }), subscription), false);
  assert.equal(matchesSubscription(coreEvent({ deliveryEligible: false }), subscription), false);

  const lifecycle = coreEvent({ findingId: null, eventType: "run.completed", payload: {}, findingType: undefined, routingTags: [] });
  assert.equal(matchesSubscription(lifecycle, subscription), true);
  assert.equal(matchesSubscription(lifecycle, coreSubscription({
    selectors: {
      streamIds: ["stream.m2.worker"],
      findingTypes: ["monitor.change", "monitor.alert"],
      routingTags: { mode: "all", values: ["important", "japan"] },
      eventTypes: ["finding.submitted"],
    },
  })), false);
});

class ConsumerAuth implements ConsumerAuthPort {
  readonly context: ConsumerAuthContext;
  constructor(context: ConsumerAuthContext) { this.context = context; }
  getContext(): ConsumerAuthContext { return structuredClone(this.context); }
}

class ConsumerCursorCodec implements CursorCodec {
  #next = 0;
  readonly #claims = new Map<string, DeliveryCursorClaims>();
  encode(claims: DeliveryCursorClaims): string {
    const token = `cursor-m2-${++this.#next}`;
    this.#claims.set(token, structuredClone(claims));
    return token;
  }
  decode(token: string): DeliveryCursorClaims {
    const claims = this.#claims.get(token);
    if (!claims) throw new Error("invalid_cursor");
    return structuredClone(claims);
  }
}

class ConsumerRepository implements DeliveryConsumerRepository {
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly deliveries = new Map<string, SubscriptionDeliveryRecord>();
  readonly #acks = new Map<string, { hash: string; result: AcknowledgeRepositoryResult }>();
  readonly #replays = new Map<string, ReplayRepositoryResult>();
  #nextSubscription = 0;
  #nextDelivery = 0;
  #position = 0;

  async createSubscription(input: CreateSubscriptionRecord): Promise<SubscriptionRecord> {
    const id = `subscription-m2-${++this.#nextSubscription}`;
    const record: SubscriptionRecord = {
      id,
      tenantId: input.scope.tenantId,
      consumerId: input.scope.consumerId,
      name: input.name,
      selectors: structuredClone(input.selectors),
      selectorHash: input.selectorHash,
      selectorVersion: 1,
      delivery: structuredClone(input.delivery),
      status: "active",
      activationPosition: String(this.#position),
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    this.subscriptions.set(id, record);
    return structuredClone(record);
  }

  async getSubscription(scope: ConsumerScope, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(subscriptionId);
    return record && record.tenantId === scope.tenantId && record.consumerId === scope.consumerId
      ? structuredClone(record)
      : null;
  }

  async listSubscriptions(scope: ConsumerScope): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter((record) => record.tenantId === scope.tenantId && record.consumerId === scope.consumerId)
      .map((record) => structuredClone(record));
  }

  async updateSubscription(input: UpdateSubscriptionRecord): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(input.subscriptionId);
    if (!record || record.tenantId !== input.scope.tenantId || record.consumerId !== input.scope.consumerId) return null;
    if (record.selectorVersion !== input.expectedSelectorVersion) throw new DeliveryConsumerRepositoryError("subscription_conflict");
    if (input.selectors !== undefined && input.selectorHash !== undefined) {
      record.selectors = structuredClone(input.selectors);
      record.selectorHash = input.selectorHash;
      record.selectorVersion += 1;
    }
    if (input.name !== undefined) record.name = input.name;
    if (input.delivery !== undefined) record.delivery = structuredClone(input.delivery);
    if (input.status !== undefined) record.status = input.status;
    return structuredClone(record);
  }

  async pullPage(input: PullPageQuery): Promise<PullPageRepositoryResult> {
    const candidates = [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriptionId === input.subscriptionId)
      .filter((delivery) => delivery.status !== "acknowledged" && delivery.status !== "dead")
      .filter((delivery) => BigInt(delivery.event.position) > BigInt(input.afterPosition))
      .sort((left, right) => BigInt(left.event.position) < BigInt(right.event.position) ? -1 : 1);
    const items = candidates.slice(0, input.limit).map((delivery) => structuredClone(delivery));
    return {
      items,
      nextPosition: items.at(-1)?.event.position ?? input.afterPosition,
      hasMore: candidates.length > input.limit,
      ackPosition: null,
    };
  }

  async acknowledge(input: {
    scope: ConsumerScope;
    subscriptionId: string;
    deliveryIds: string[];
    ackThroughPosition: string | null;
    idempotencyKey: string;
    payloadHash: string;
  }): Promise<AcknowledgeRepositoryResult> {
    const key = `${input.subscriptionId}:${input.idempotencyKey}`;
    const previous = this.#acks.get(key);
    if (previous) {
      if (previous.hash !== input.payloadHash) throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
      return structuredClone(previous.result);
    }
    const records = input.deliveryIds.map((id) => this.deliveries.get(id));
    if (records.some((record) => !record || record.subscriptionId !== input.subscriptionId)) {
      throw new DeliveryConsumerRepositoryError("not_found");
    }
    for (const record of records) record!.status = "acknowledged";
    const result = {
      acknowledgementId: `ack-m2-${this.#acks.size + 1}`,
      acknowledgedDeliveryIds: [...input.deliveryIds],
      ackPosition: input.ackThroughPosition,
    };
    this.#acks.set(key, { hash: input.payloadHash, result });
    return structuredClone(result);
  }

  async listDeadLetters(input: DeadLetterQuery): Promise<DeadLetterRecord[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriptionId === input.subscriptionId && delivery.status === "dead")
      .slice(0, input.limit)
      .map((delivery) => ({ ...structuredClone(delivery), deadAt: "2026-08-18T00:00:00.000Z" }));
  }

  async replayDeadLetter(input: ReplayDeadLetterRecord): Promise<ReplayRepositoryResult> {
    const key = `${input.subscriptionId}:${input.idempotencyKey}`;
    const previous = this.#replays.get(key);
    if (previous) {
      if (previous.delivery.event.eventId !== this.deliveries.get(input.deliveryId)?.event.eventId) {
        throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
      }
      return structuredClone(previous);
    }
    const delivery = this.deliveries.get(input.deliveryId);
    if (!delivery || delivery.subscriptionId !== input.subscriptionId || delivery.status !== "dead") {
      throw new DeliveryConsumerRepositoryError("not_found");
    }
    delivery.status = "pending";
    delivery.attemptCount += 1;
    const result = { replayId: `replay-m2-${this.#replays.size + 1}`, delivery: structuredClone(delivery) };
    this.#replays.set(key, structuredClone(result));
    return result;
  }

  addDelivery(subscriptionId: string, event: Omit<DeliveryEventRecord, "position">): SubscriptionDeliveryRecord {
    const delivery: SubscriptionDeliveryRecord = {
      deliveryId: `delivery-m2-${++this.#nextDelivery}`,
      subscriptionId,
      event: { ...structuredClone(event), position: String(++this.#position) },
      attemptCount: 0,
      status: "pending",
      nextAttemptAt: null,
      lastError: null,
    };
    this.deliveries.set(delivery.deliveryId, delivery);
    return structuredClone(delivery);
  }

  markDead(deliveryId: string): void {
    const delivery = this.deliveries.get(deliveryId);
    assert.ok(delivery);
    delivery!.status = "dead";
  }
}

function consumerHasher(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(consumerHasher).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${consumerHasher(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function consumerService(repository: ConsumerRepository, tenantId: string, consumerId: string, codec = new ConsumerCursorCodec()): DeliveryConsumerService {
  return new DeliveryConsumerService({
    repository,
    auth: new ConsumerAuth({ tenantId, consumerId, allowedStreamIds: ["shared.monitor"] }),
    cursorCodec: codec,
    payloadHasher: { hash: consumerHasher },
  });
}

function consumerEvent(overrides: Partial<Omit<DeliveryEventRecord, "position">> = {}): Omit<DeliveryEventRecord, "position"> {
  return {
    eventId: "evt_m2_consumer_001",
    eventType: "finding.submitted",
    streamId: "shared.monitor",
    runId: "run_m2_consumer_001",
    findingId: "finding_m2_consumer_001",
    occurredAt: "2026-08-18T00:00:00Z",
    attempt: 1,
    payload: { finding: { finding_type: "monitor.change" } },
    findingType: "monitor.change",
    routingTags: ["important", "japan"],
    traceId: TRACE_ID,
    ...overrides,
  };
}

test("consumer service isolates tenant/subscription cursors and supports exact any/all/event selectors", async () => {
  const repository = new ConsumerRepository();
  const codec = new ConsumerCursorCodec();
  const tenantA = consumerService(repository, "tenant_a", "consumer_a", codec);
  const tenantB = consumerService(repository, "tenant_b", "consumer_b", codec);
  const subscriptionA = await tenantA.createSubscription({
    name: "tenant-a-feed",
    selectors: {
      streamIds: ["shared.monitor"],
      findingTypes: ["monitor.change", "monitor.alert"],
      routingTags: { mode: "all", values: ["important", "japan"] },
      eventTypes: ["finding.submitted", "run.completed"],
    },
    delivery: { mode: "pull" },
  });
  const subscriptionB = await tenantB.createSubscription({
    name: "tenant-b-feed",
    selectors: { streamIds: ["shared.monitor"] },
    delivery: { mode: "pull" },
  });
  const aDelivery = repository.addDelivery(subscriptionA.id, consumerEvent());
  repository.addDelivery(subscriptionB.id, consumerEvent({ eventId: "evt_m2_consumer_002" }));

  const page = await tenantA.pullPage({ subscriptionId: subscriptionA.id, limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.event.eventId, aDelivery.event.eventId);
  await assert.rejects(
    tenantA.pullPage({ subscriptionId: subscriptionB.id, cursor: page.nextCursor }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
  await assert.rejects(
    tenantB.pullPage({ subscriptionId: subscriptionB.id, cursor: page.nextCursor }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "cursor_scope_mismatch",
  );

  const selector = normalizeSelector({
    streamIds: ["shared.monitor"],
    findingTypes: ["monitor.change", "monitor.alert"],
    routingTags: { mode: "any", values: ["important", "missing"] },
    eventTypes: ["finding.submitted"],
  });
  const matching = {
    ...consumerEvent(),
    position: "1",
  } as DeliveryEventRecord;
  assert.equal(matchesSelector(selector, matching), true);
  assert.equal(matchesSelector(selector, { ...matching, routingTags: ["other"] }), false);
  assert.equal(matchesSelector(selector, { ...matching, eventType: "run.completed", findingId: null }), false);
  const lifecycleSelector = normalizeSelector({ streamIds: ["shared.monitor"], eventTypes: ["run.completed"] });
  assert.equal(matchesSelector(lifecycleSelector, { ...matching, eventType: "run.completed", findingId: null, findingType: null, routingTags: [] }), true);
});

test("consumer acknowledgement and dead-letter replay are idempotent without changing event identity", async () => {
  const repository = new ConsumerRepository();
  const service = consumerService(repository, "tenant_a", "consumer_a");
  const subscription = await service.createSubscription({
    name: "tenant-a-feed",
    selectors: { streamIds: ["shared.monitor"] },
    delivery: { mode: "pull" },
  });
  const delivery = repository.addDelivery(subscription.id, consumerEvent());
  const firstAck = await service.acknowledge({ subscriptionId: subscription.id, deliveryIds: [delivery.deliveryId], idempotencyKey: "ack-m2-001" });
  const secondAck = await service.acknowledge({ subscriptionId: subscription.id, deliveryIds: [delivery.deliveryId], idempotencyKey: "ack-m2-001" });
  assert.deepEqual(secondAck, firstAck);

  const dead = repository.addDelivery(subscription.id, consumerEvent({ eventId: "evt_m2_consumer_dead" }));
  repository.markDead(dead.deliveryId);
  const replay1 = await service.replayDeadLetter({ subscriptionId: subscription.id, deliveryId: dead.deliveryId, idempotencyKey: "replay-m2-001" });
  const replay2 = await service.replayDeadLetter({ subscriptionId: subscription.id, deliveryId: dead.deliveryId, idempotencyKey: "replay-m2-001" });
  assert.deepEqual(replay2, replay1);
  assert.equal(replay1.delivery.event.eventId, dead.event.eventId);
  assert.equal(replay1.delivery.attemptCount, dead.attemptCount + 1);

  await assert.rejects(
    service.acknowledge({ subscriptionId: subscription.id, deliveryIds: [dead.deliveryId], idempotencyKey: "ack-m2-001" }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "idempotency_payload_conflict",
  );
});
