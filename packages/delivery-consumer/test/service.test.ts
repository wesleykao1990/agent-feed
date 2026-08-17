import assert from "node:assert/strict";
import test from "node:test";
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
} from "../src/index.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const hasher = { hash: canonical };

class StaticAuth implements ConsumerAuthPort {
  readonly context: ConsumerAuthContext;

  constructor(context: ConsumerAuthContext) {
    this.context = context;
  }

  getContext(): ConsumerAuthContext {
    return clone(this.context);
  }
}

class TestCursorCodec implements CursorCodec {
  #counter = 0;
  readonly #claims = new Map<string, DeliveryCursorClaims>();

  encode(claims: DeliveryCursorClaims): string {
    const token = `opaque-${++this.#counter}`;
    this.#claims.set(token, clone(claims));
    return token;
  }

  decode(token: string): DeliveryCursorClaims {
    const claims = this.#claims.get(token);
    if (!claims) throw new Error("invalid_cursor");
    return clone(claims);
  }
}

class MemoryRepository implements DeliveryConsumerRepository {
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly deliveries = new Map<string, SubscriptionDeliveryRecord>();
  readonly #ackReceipts = new Map<string, { hash: string; result: AcknowledgeRepositoryResult }>();
  readonly #replayReceipts = new Map<string, ReplayRepositoryResult>();
  #position = 0;
  #sequence = 0;

  async createSubscription(input: CreateSubscriptionRecord): Promise<SubscriptionRecord> {
    const id = `sub-${++this.#sequence}`;
    const record: SubscriptionRecord = {
      id,
      tenantId: input.scope.tenantId,
      consumerId: input.scope.consumerId,
      name: input.name,
      selectors: clone(input.selectors),
      selectorHash: input.selectorHash,
      selectorVersion: 1,
      delivery: clone(input.delivery),
      status: "active",
      activationPosition: String(this.#position),
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    this.subscriptions.set(id, record);
    return clone(record);
  }

  async getSubscription(scope: ConsumerScope, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(subscriptionId);
    if (!record || !sameScope(record, scope)) return null;
    return clone(record);
  }

  async listSubscriptions(scope: ConsumerScope): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter((record) => sameScope(record, scope))
      .map(clone);
  }

  async updateSubscription(input: UpdateSubscriptionRecord): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(input.subscriptionId);
    if (!record || !sameScope(record, input.scope)) return null;
    if (record.selectorVersion !== input.expectedSelectorVersion) {
      throw new DeliveryConsumerRepositoryError("subscription_conflict", "selector_version_conflict");
    }
    if (input.name !== undefined) record.name = input.name;
    if (input.delivery !== undefined) record.delivery = clone(input.delivery);
    if (input.status !== undefined) record.status = input.status;
    if (input.selectors !== undefined && input.selectorHash !== undefined) {
      record.selectors = clone(input.selectors);
      record.selectorHash = input.selectorHash;
      record.selectorVersion += 1;
      record.activationPosition = String(this.#position);
    }
    return clone(record);
  }

  async pullPage(input: PullPageQuery): Promise<PullPageRepositoryResult> {
    const after = BigInt(input.afterPosition);
    const candidates = [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriptionId === input.subscriptionId)
      .filter((delivery) => delivery.status !== "acknowledged" && delivery.status !== "dead")
      .filter((delivery) => BigInt(delivery.event.position) > after)
      .sort((left, right) => Number(BigInt(left.event.position) - BigInt(right.event.position)));
    const items = candidates.slice(0, input.limit).map(clone);
    const nextPosition = items.at(-1)?.event.position ?? input.afterPosition;
    return {
      items,
      nextPosition,
      hasMore: candidates.length > input.limit,
      ackPosition: this.#highestAcknowledgedPosition(input.subscriptionId),
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
    const key = `${input.subscriptionId}|${input.idempotencyKey}`;
    const previous = this.#ackReceipts.get(key);
    if (previous) {
      if (previous.hash !== input.payloadHash) {
        throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
      }
      return clone(previous.result);
    }
    const selected = input.deliveryIds.map((id) => this.deliveries.get(id));
    if (selected.some((delivery) => !delivery || delivery.subscriptionId !== input.subscriptionId)) {
      throw new DeliveryConsumerRepositoryError("not_found");
    }
    for (const delivery of selected) delivery!.status = "acknowledged";
    const result: AcknowledgeRepositoryResult = {
      acknowledgementId: `ack-${this.#ackReceipts.size + 1}`,
      acknowledgedDeliveryIds: [...input.deliveryIds],
      ackPosition: this.#highestAcknowledgedPosition(input.subscriptionId),
    };
    this.#ackReceipts.set(key, { hash: input.payloadHash, result: clone(result) });
    return clone(result);
  }

  async listDeadLetters(input: DeadLetterQuery): Promise<DeadLetterRecord[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriptionId === input.subscriptionId && delivery.status === "dead")
      .slice(0, input.limit)
      .map((delivery) => ({ ...clone(delivery), deadAt: "2026-08-18T00:00:00.000Z" }));
  }

  async replayDeadLetter(input: ReplayDeadLetterRecord): Promise<ReplayRepositoryResult> {
    const key = `${input.subscriptionId}|${input.idempotencyKey}`;
    const previous = this.#replayReceipts.get(key);
    if (previous) return clone(previous);
    const delivery = this.deliveries.get(input.deliveryId);
    if (!delivery || delivery.subscriptionId !== input.subscriptionId || delivery.status !== "dead") {
      throw new DeliveryConsumerRepositoryError("not_found");
    }
    delivery.status = "pending";
    delivery.attemptCount += 1;
    const result = { replayId: `replay-${this.#replayReceipts.size + 1}`, delivery: clone(delivery) };
    this.#replayReceipts.set(key, clone(result));
    return clone(result);
  }

  addEvent(
    scope: ConsumerScope,
    eventInput: Omit<DeliveryEventRecord, "position">,
  ): DeliveryEventRecord {
    const event: DeliveryEventRecord = { ...clone(eventInput), position: String(++this.#position) };
    for (const subscription of this.subscriptions.values()) {
      if (!sameScope(subscription, scope) || subscription.status !== "active") continue;
      if (BigInt(event.position) <= BigInt(subscription.activationPosition)) continue;
      if (!matchesSelector(subscription.selectors, event)) continue;
      const delivery: SubscriptionDeliveryRecord = {
        deliveryId: `delivery-${++this.#sequence}`,
        subscriptionId: subscription.id,
        event: clone(event),
        attemptCount: 0,
        status: "pending",
        nextAttemptAt: null,
        lastError: null,
      };
      this.deliveries.set(delivery.deliveryId, delivery);
    }
    return clone(event);
  }

  markDead(deliveryId: string): void {
    const delivery = this.deliveries.get(deliveryId);
    assert.ok(delivery);
    delivery!.status = "dead";
  }

  #highestAcknowledgedPosition(subscriptionId: string): string | null {
    const deliveries = [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriptionId === subscriptionId)
      .sort((left, right) => Number(BigInt(left.event.position) - BigInt(right.event.position)));
    let result: string | null = null;
    for (const delivery of deliveries) {
      if (delivery.status !== "acknowledged") break;
      result = delivery.event.position;
    }
    return result;
  }
}

function sameScope(record: { tenantId: string; consumerId: string }, scope: ConsumerScope): boolean {
  return record.tenantId === scope.tenantId && record.consumerId === scope.consumerId;
}

function service(repository: MemoryRepository, context: ConsumerAuthContext, codec = new TestCursorCodec()): DeliveryConsumerService {
  return new DeliveryConsumerService({ repository, auth: new StaticAuth(context), cursorCodec: codec, payloadHasher: hasher });
}

function auth(tenantId: string, consumerId: string, streams = ["stream-a"]): ConsumerAuthContext {
  return { tenantId, consumerId, allowedStreamIds: streams };
}

let eventCounter = 0;

function event(overrides: Partial<Omit<DeliveryEventRecord, "position">> = {}): Omit<DeliveryEventRecord, "position"> {
  return {
    eventId: `event-${++eventCounter}`,
    eventType: "finding.submitted",
    streamId: "stream-a",
    runId: "run-1",
    findingId: "finding-1",
    occurredAt: "2026-08-18T00:00:00.000Z",
    attempt: 1,
    payload: { finding: { finding_type: "type-a" } },
    findingType: "type-a",
    routingTags: ["tag-a"],
    traceId: "trace-1",
    ...overrides,
  };
}

function createInput(overrides: Partial<Parameters<DeliveryConsumerService["createSubscription"]>[0]> = {}) {
  return {
    name: "consumer-feed",
    selectors: { streamIds: ["stream-a"] },
    delivery: { mode: "pull" as const },
    ...overrides,
  };
}

test("exact stream authorization rejects an unauthorized subscription", async () => {
  const repo = new MemoryRepository();
  const app = service(repo, auth("tenant-a", "consumer-a"));
  await assert.rejects(
    app.createSubscription(createInput({ selectors: { streamIds: ["stream-b"] } })),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "unauthorized_stream",
  );
});

test("webhook delivery requires endpoint and signing-key references", async () => {
  const repo = new MemoryRepository();
  const app = service(repo, auth("tenant-a", "consumer-a"));
  await assert.rejects(
    app.createSubscription(createInput({
      delivery: { mode: "webhook", endpointRef: "endpoint-a" } as never,
    })),
    (error: unknown) => error instanceof DeliveryConsumerError
      && error.code === "invalid_input"
      && error.message === "signing_key_id_must_be_non_empty",
  );
  await assert.rejects(
    app.createSubscription(createInput({
      delivery: { mode: "webhook", signingKeyId: "key-a" } as never,
    })),
    (error: unknown) => error instanceof DeliveryConsumerError
      && error.code === "invalid_input"
      && error.message === "endpoint_ref_must_be_non_empty",
  );
  await assert.rejects(
    app.createSubscription(createInput({
      delivery: { mode: "pull", endpointRef: "endpoint-a", signingKeyId: "key-a" } as never,
    })),
    (error: unknown) => error instanceof DeliveryConsumerError
      && error.code === "invalid_input"
      && error.message === "pull_delivery_cannot_have_webhook_configuration",
  );
});

test("existing subscriptions are hidden when a credential loses stream access", async () => {
  const repo = new MemoryRepository();
  const owner = service(repo, auth("tenant-a", "consumer-a"));
  const subscription = await owner.createSubscription(createInput());
  const narrowed = service(repo, auth("tenant-a", "consumer-a", ["stream-b"]));

  assert.equal((await narrowed.listSubscriptions()).length, 0);
  await assert.rejects(
    narrowed.pullPage({ subscriptionId: subscription.id }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
});

test("tenant and consumer scope prevents listing, pulling, and replaying another feed", async () => {
  const repo = new MemoryRepository();
  const owner = service(repo, auth("tenant-a", "consumer-a"));
  const other = service(repo, auth("tenant-b", "consumer-b"));
  const ownerSubscription = await owner.createSubscription(createInput());
  const otherSubscription = await other.createSubscription(createInput());
  const otherEvent = repo.addEvent({ tenantId: "tenant-b", consumerId: "consumer-b" }, event());
  const otherDelivery = [...repo.deliveries.values()].find((item) => item.event.eventId === otherEvent.eventId)!;
  repo.markDead(otherDelivery.deliveryId);

  assert.equal((await owner.listSubscriptions()).length, 1);
  await assert.rejects(
    owner.pullPage({ subscriptionId: otherSubscription.id }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
  await assert.rejects(
    owner.listDeadLetters({ subscriptionId: otherSubscription.id }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
  await assert.rejects(
    owner.replayDeadLetter({ subscriptionId: otherSubscription.id, deliveryId: otherDelivery.deliveryId, idempotencyKey: "replay-1" }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
  assert.equal((await other.listSubscriptions())[0]!.id, otherSubscription.id);
  assert.notEqual(ownerSubscription.id, otherSubscription.id);
});

test("cursor is opaque and bound to the subscription selector version", async () => {
  const repo = new MemoryRepository();
  const codec = new TestCursorCodec();
  const app = service(repo, auth("tenant-a", "consumer-a"), codec);
  const first = await app.createSubscription(createInput({ name: "first" }));
  const second = await app.createSubscription(createInput({ name: "second" }));
  repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-a" }, event());
  const page = await app.pullPage({ subscriptionId: first.id });
  assert.match(page.nextCursor, /^opaque-/);
  await assert.rejects(
    app.pullPage({ subscriptionId: second.id, cursor: page.nextCursor }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "cursor_scope_mismatch",
  );
  await assert.rejects(
    app.pullPage({ subscriptionId: first.id, cursor: "tampered" }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "cursor_invalid",
  );
});

test("acknowledgement idempotency rejects payload drift under one key", async () => {
  const repo = new MemoryRepository();
  const app = service(repo, auth("tenant-a", "consumer-a"));
  const subscription = await app.createSubscription(createInput());
  const first = repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-a" }, event({ eventId: "event-1" }));
  const second = repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-a" }, event({ eventId: "event-2" }));
  const firstDelivery = [...repo.deliveries.values()].find((item) => item.event.eventId === first.eventId)!;
  const secondDelivery = [...repo.deliveries.values()].find((item) => item.event.eventId === second.eventId)!;
  await app.acknowledge({ subscriptionId: subscription.id, deliveryIds: [firstDelivery.deliveryId], idempotencyKey: "ack-1" });
  await assert.rejects(
    app.acknowledge({ subscriptionId: subscription.id, deliveryIds: [secondDelivery.deliveryId], idempotencyKey: "ack-1" }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "idempotency_payload_conflict",
  );
});

test("replay is scoped to the owning subscription", async () => {
  const repo = new MemoryRepository();
  const owner = service(repo, auth("tenant-a", "consumer-a"));
  const other = service(repo, auth("tenant-a", "consumer-b"));
  const ownerSubscription = await owner.createSubscription(createInput());
  const otherSubscription = await other.createSubscription(createInput({ name: "other" }));
  const otherEvent = repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-b" }, event({ eventId: "other-event" }));
  const otherDelivery = [...repo.deliveries.values()].find((item) => item.event.eventId === otherEvent.eventId)!;
  repo.markDead(otherDelivery.deliveryId);

  await assert.rejects(
    owner.replayDeadLetter({ subscriptionId: otherSubscription.id, deliveryId: otherDelivery.deliveryId, idempotencyKey: "replay-1" }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "not_found",
  );
  const replay = await other.replayDeadLetter({ subscriptionId: otherSubscription.id, deliveryId: otherDelivery.deliveryId, idempotencyKey: "replay-1" });
  assert.equal(replay.delivery.status, "pending");
  assert.equal(replay.delivery.event.eventId, "other-event");
  assert.equal(ownerSubscription.id !== otherSubscription.id, true);
});

test("unexpected repository errors are mapped without exposing raw diagnostics", async () => {
  const repo = new MemoryRepository();
  repo.listSubscriptions = async () => {
    throw new Error("secret=https://private.example/token");
  };
  const app = service(repo, auth("tenant-a", "consumer-a"));
  await assert.rejects(
    app.listSubscriptions(),
    (error: unknown) => error instanceof DeliveryConsumerError
      && error.code === "invalid_state"
      && error.message === "repository_operation_failed",
  );
});

test("finding selectors use OR types and explicit any/all tags while lifecycle events use stream/type", () => {
  const selector = normalizeSelector({
    streamIds: ["stream-a"],
    findingTypes: ["type-a", "type-b"],
    routingTags: { mode: "all", values: ["tag-a", "tag-b"] },
    eventTypes: ["finding.submitted", "run.completed"],
  });
  assert.equal(matchesSelector(selector, event({ findingType: "type-a", routingTags: ["tag-a", "tag-b"] }) as DeliveryEventRecord), true);
  assert.equal(matchesSelector(selector, event({ findingType: "type-c", routingTags: ["tag-a", "tag-b"] }) as DeliveryEventRecord), false);
  assert.equal(matchesSelector(selector, event({ findingType: "type-a", routingTags: ["tag-a"] }) as DeliveryEventRecord), false);
  assert.equal(matchesSelector(selector, event({ eventType: "run.completed", findingId: null, findingType: null, routingTags: [] }) as DeliveryEventRecord), true);
});

test("new subscriptions activate in the future and selector updates increment versions", async () => {
  const repo = new MemoryRepository();
  const app = service(repo, auth("tenant-a", "consumer-a"));
  repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-a" }, event({ eventId: "before-subscription" }));
  const subscription = await app.createSubscription(createInput());
  assert.equal((await app.pullPage({ subscriptionId: subscription.id })).items.length, 0);
  repo.addEvent({ tenantId: "tenant-a", consumerId: "consumer-a" }, event({ eventId: "after-subscription" }));
  const page = await app.pullPage({ subscriptionId: subscription.id });
  assert.equal(page.items.length, 1);
  const updated = await app.updateSubscription({
    subscriptionId: subscription.id,
    expectedSelectorVersion: subscription.selectorVersion,
    selectors: { streamIds: ["stream-a"], findingTypes: ["type-b"] },
  });
  assert.equal(updated.selectorVersion, subscription.selectorVersion + 1);
  const afterUpdate = await app.pullPage({ subscriptionId: subscription.id });
  assert.deepEqual(afterUpdate.items.map((item) => item.event.eventId), ["after-subscription"]);
  await assert.rejects(
    app.pullPage({ subscriptionId: subscription.id, cursor: page.nextCursor }),
    (error: unknown) => error instanceof DeliveryConsumerError && error.code === "cursor_scope_mismatch",
  );
});
