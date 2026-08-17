import assert from "node:assert/strict";
import test from "node:test";
import {
  DeliveryConsumerRepositoryError,
  type ConsumerAuthContext,
  type ConsumerScope,
  type CreateSubscriptionRecord,
  type CursorCodec,
  type DeliveryConsumerRepository,
  type DeliveryCursorClaims,
  type DeadLetterQuery,
  type DeadLetterRecord,
  type PullPageQuery,
  type PullPageRepositoryResult,
  type ReplayDeadLetterRecord,
  type ReplayRepositoryResult,
  type SubscriptionRecord,
  type UpdateSubscriptionRecord,
  type AcknowledgeRepositoryResult,
} from "@agent-feed/delivery-consumer";
import { createDeliveryApiHandlers } from "../src/index.ts";
import type { DeliveryApiHandlers } from "../src/index.ts";

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

class TestCursorCodec implements CursorCodec {
  #counter = 0;
  readonly #claims = new Map<string, DeliveryCursorClaims>();

  encode(claims: DeliveryCursorClaims): string {
    const token = `cursor-${++this.#counter}`;
    this.#claims.set(token, clone(claims));
    return token;
  }

  decode(token: string): DeliveryCursorClaims {
    const claims = this.#claims.get(token);
    if (!claims) throw new Error("invalid_cursor");
    return clone(claims);
  }
}

class ApiRepository implements DeliveryConsumerRepository {
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  lastCreateInput: CreateSubscriptionRecord | null = null;
  readonly #ackReceipts = new Map<string, { hash: string; result: AcknowledgeRepositoryResult }>();
  #sequence = 0;

  async createSubscription(input: CreateSubscriptionRecord): Promise<SubscriptionRecord> {
    this.lastCreateInput = clone(input);
    const record: SubscriptionRecord = {
      id: `sub-${++this.#sequence}`,
      tenantId: input.scope.tenantId,
      consumerId: input.scope.consumerId,
      name: input.name,
      selectors: clone(input.selectors),
      selectorHash: input.selectorHash,
      selectorVersion: 1,
      delivery: clone(input.delivery),
      status: "active",
      activationPosition: "0",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    this.subscriptions.set(record.id, record);
    return clone(record);
  }

  async getSubscription(scope: ConsumerScope, id: string): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(id);
    if (!record || record.tenantId !== scope.tenantId || record.consumerId !== scope.consumerId) return null;
    return clone(record);
  }

  async listSubscriptions(scope: ConsumerScope): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter((record) => record.tenantId === scope.tenantId && record.consumerId === scope.consumerId)
      .map(clone);
  }

  async updateSubscription(input: UpdateSubscriptionRecord): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(input.subscriptionId);
    if (!record || record.tenantId !== input.scope.tenantId || record.consumerId !== input.scope.consumerId) return null;
    if (record.selectorVersion !== input.expectedSelectorVersion) throw new DeliveryConsumerRepositoryError("subscription_conflict");
    if (input.name !== undefined) record.name = input.name;
    if (input.selectors !== undefined && input.selectorHash !== undefined) {
      record.selectors = clone(input.selectors);
      record.selectorHash = input.selectorHash;
      record.selectorVersion += 1;
    }
    if (input.delivery !== undefined) record.delivery = clone(input.delivery);
    if (input.status !== undefined) record.status = input.status;
    return clone(record);
  }

  async pullPage(input: PullPageQuery): Promise<PullPageRepositoryResult> {
    return { items: [], nextPosition: input.afterPosition, hasMore: false, ackPosition: null };
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
      if (previous.hash !== input.payloadHash) throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
      return clone(previous.result);
    }
    const result = {
      acknowledgementId: `ack-${this.#ackReceipts.size + 1}`,
      acknowledgedDeliveryIds: [...input.deliveryIds],
      ackPosition: null,
    } satisfies AcknowledgeRepositoryResult;
    this.#ackReceipts.set(key, { hash: input.payloadHash, result });
    return clone(result);
  }

  async listDeadLetters(_input: DeadLetterQuery): Promise<DeadLetterRecord[]> {
    return [];
  }

  async replayDeadLetter(_input: ReplayDeadLetterRecord): Promise<ReplayRepositoryResult> {
    throw new DeliveryConsumerRepositoryError("not_found");
  }
}

const contexts = new Map<string, ConsumerAuthContext>([
  ["credential-a", { tenantId: "tenant-a", consumerId: "consumer-a", allowedStreamIds: ["stream-a"] }],
  ["credential-b", { tenantId: "tenant-b", consumerId: "consumer-b", allowedStreamIds: ["stream-a"] }],
]);

function handlers(repository = new ApiRepository()): DeliveryApiHandlers {
  return createDeliveryApiHandlers({
    repository,
    credentials: {
      resolve(credential: unknown): ConsumerAuthContext {
        const context = contexts.get(String(credential));
        if (!context) throw new Error("credential_invalid");
        return context;
      },
    },
    cursorCodec: new TestCursorCodec(),
    payloadHasher: { hash: canonical },
    nowSeconds: () => 1_755_475_200,
  });
}

function createRequest(credential: string, body: Record<string, unknown> = {}) {
  return {
    credential,
    body: {
      name: "feed",
      selectors: { streamIds: ["stream-a"] },
      delivery: { mode: "pull" },
      ...body,
    },
  };
}

test("credential resolver controls scope and body tenant fields are rejected", async () => {
  const repo = new ApiRepository();
  const api = handlers(repo);
  const response = await api.createSubscription(createRequest("credential-a", { tenantId: "tenant-b" }));
  assert.equal(response.status, 400);
  assert.equal(repo.subscriptions.size, 0);
  const unauthorized = await api.listSubscriptions({ credential: "unknown" });
  assert.equal(unauthorized.status, 401);
});

test("composition factory passes the canonical future-only selector to an injected repository", async () => {
  const repo = new ApiRepository();
  const api = handlers(repo);
  const response = await api.createSubscription(createRequest("credential-a", {
    selectors: {
      streamIds: ["stream-a"],
      findingTypes: ["type-b", "type-a"],
      routingTags: { mode: "all", values: ["tag-b", "tag-a"] },
      eventTypes: ["run.completed", "finding.submitted"],
    },
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(repo.lastCreateInput?.scope, { tenantId: "tenant-a", consumerId: "consumer-a" });
  assert.equal(repo.lastCreateInput?.activation, "future");
  assert.deepEqual(repo.lastCreateInput?.selectors, {
    streamIds: ["stream-a"],
    findingTypes: ["type-a", "type-b"],
    routingTags: { mode: "all", values: ["tag-a", "tag-b"] },
    eventTypes: ["finding.submitted", "run.completed"],
  });
});

test("API rejects incomplete webhook configuration and pull endpoint fields", async () => {
  const api = handlers();
  const missingKey = await api.createSubscription(createRequest("credential-a", {
    delivery: { mode: "webhook", endpointRef: "endpoint-a" },
  }));
  assert.equal(missingKey.status, 400);
  const pullWithEndpoint = await api.createSubscription(createRequest("credential-a", {
    delivery: { mode: "pull", endpointRef: "endpoint-a", signingKeyId: "key-a" },
  }));
  assert.equal(pullWithEndpoint.status, 400);
});

test("cross-tenant subscription paths return not_found", async () => {
  const repo = new ApiRepository();
  const api = handlers(repo);
  const created = await api.createSubscription(createRequest("credential-a"));
  assert.equal(created.status, 201);
  const subscriptionId = (created.body as { id: string }).id;
  const response = await api.pullPage({
    credential: "credential-b",
    params: { subscriptionId },
  });
  assert.equal(response.status, 404);
  const listed = await api.listSubscriptions({ credential: "credential-b" });
  assert.deepEqual(listed.body, []);
});

test("cursor binding and acknowledgement idempotency are mapped at the application boundary", async () => {
  const repo = new ApiRepository();
  const api = handlers(repo);
  const first = await api.createSubscription(createRequest("credential-a"));
  const second = await api.createSubscription(createRequest("credential-a", { name: "second" }));
  const firstId = (first.body as { id: string }).id;
  const secondId = (second.body as { id: string }).id;
  const page = await api.pullPage({ credential: "credential-a", params: { subscriptionId: firstId } });
  const cursor = (page.body as { nextCursor: string }).nextCursor;
  const wrongSubscription = await api.pullPage({
    credential: "credential-a",
    params: { subscriptionId: secondId },
    query: { cursor },
  });
  assert.equal(wrongSubscription.status, 400);

  const firstAck = await api.acknowledge({
    credential: "credential-a",
    params: { subscriptionId: firstId },
    body: { deliveryIds: ["delivery-1"], idempotencyKey: "ack-1" },
  });
  assert.equal(firstAck.status, 200);
  const conflict = await api.acknowledge({
    credential: "credential-a",
    params: { subscriptionId: firstId },
    body: { deliveryIds: ["delivery-2"], idempotencyKey: "ack-1" },
  });
  assert.equal(conflict.status, 409);
});
