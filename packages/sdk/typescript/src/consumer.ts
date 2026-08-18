import {
  AgentFeedClient,
  type AgentFeedClientOptions,
  type AgentFeedRequestOptions,
} from "./client.ts";
import { AgentFeedResponseError } from "./errors.ts";
import type {
  ConsumerAcknowledgeOptions,
  ConsumerAcknowledgeResult,
  ConsumerDelivery,
  ConsumerPullPage,
  ConsumerReplayOptions,
  ConsumerReplayResult,
  ConsumerSubscriptionView,
  CreateSubscriptionInput,
  ListDeadLettersOptions,
  PullPageOptions,
  UpdateSubscriptionInput,
} from "./types.ts";
import type { DeliveryEventType } from "./types.ts";

export interface ConsumerClientOptions extends AgentFeedClientOptions {
  /** Consumer ID used only for the documented route path, never for auth. */
  readonly consumer_id?: string;
  readonly consumerId?: string;
  /** Override the documented `/v1/consumers/{consumer_id}` route prefix. */
  readonly consumer_prefix?: string;
  readonly consumerPrefix?: string;
  /** Opaque credential accepted by an HTTP credential resolver. */
  readonly credential?: string;
}

export interface ConsumerRequestOptions extends AgentFeedRequestOptions {}

function segment(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${field}_invalid`);
  return encodeURIComponent(value);
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentFeedResponseError({ operation });
  return value as Record<string, unknown>;
}

function arrayResponse<T>(value: unknown, operation: string): readonly T[] {
  if (!Array.isArray(value)) throw new AgentFeedResponseError({ operation });
  return value as readonly T[];
}

function pullResponse(value: unknown, operation: string): ConsumerPullPage {
  const result = record(value, operation);
  if (!Array.isArray(result.items)
    || typeof result.nextCursor !== "string"
    || (result.ackCursor !== null && typeof result.ackCursor !== "string")
    || typeof result.hasMore !== "boolean") {
    throw new AgentFeedResponseError({ operation });
  }
  return result as unknown as ConsumerPullPage;
}

function acknowledgeResponse(value: unknown, operation: string): ConsumerAcknowledgeResult {
  const result = record(value, operation);
  if (typeof result.acknowledgementId !== "string"
    || !Array.isArray(result.acknowledgedDeliveryIds)
    || (result.ackCursor !== null && typeof result.ackCursor !== "string")) {
    throw new AgentFeedResponseError({ operation });
  }
  return result as unknown as ConsumerAcknowledgeResult;
}

function replayResponse(value: unknown, operation: string): ConsumerReplayResult {
  const result = record(value, operation);
  if (typeof result.replayId !== "string" || result.delivery === null || typeof result.delivery !== "object") {
    throw new AgentFeedResponseError({ operation });
  }
  return result as unknown as ConsumerReplayResult;
}

function subscriptionResponse(value: unknown, operation: string): ConsumerSubscriptionView {
  return record(value, operation) as ConsumerSubscriptionView;
}

function requiredIdempotencyKey(options: ConsumerAcknowledgeOptions | ConsumerReplayOptions): string {
  const key = options.idempotency_key ?? options.idempotencyKey;
  if (typeof key !== "string" || key.length === 0 || key.trim() !== key) throw new Error("idempotency_key_invalid");
  return key;
}

function query(parts: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parts)) if (value !== undefined) params.set(key, value);
  const encoded = params.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}

/**
 * Consumer control/delivery client for the documented delivery-api routes.
 *
 * Cursor strings are opaque: the client only carries them between pull and
 * acknowledgement calls and never decodes, modifies, or logs them.
 */
export class ConsumerClient extends AgentFeedClient {
  readonly #prefix: string;

  constructor(options: ConsumerClientOptions) {
    const token = options.token ?? options.credential;
    super({
      ...options,
      ...(token === undefined ? {} : { token }),
    });
    const consumerId = options.consumer_id ?? options.consumerId;
    const customPrefix = options.consumer_prefix ?? options.consumerPrefix;
    if (customPrefix !== undefined) {
      if (customPrefix.length === 0 || /[?#]/u.test(customPrefix) || /^[a-z][a-z\d+.-]*:/iu.test(customPrefix)) {
        throw new Error("consumer_prefix_invalid");
      }
      this.#prefix = customPrefix.replace(/\/+$/u, "");
    } else {
      this.#prefix = `/v1/consumers${consumerId === undefined ? "" : `/${segment(consumerId, "consumer_id")}`}`;
    }
  }

  async createSubscription(
    input: CreateSubscriptionInput,
    options: ConsumerRequestOptions = {},
  ): Promise<ConsumerSubscriptionView> {
    const operation = "consumer.create_subscription";
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: `${this.#prefix}/subscriptions`,
      body: input,
      expected_status: new Set([201]),
    }, options);
    return subscriptionResponse(body, operation);
  }

  async updateSubscription(
    subscriptionId: string,
    input: UpdateSubscriptionInput,
    options: ConsumerRequestOptions = {},
  ): Promise<ConsumerSubscriptionView> {
    const operation = "consumer.update_subscription";
    const body = await this.requestJson<unknown>({
      operation,
      method: "PATCH",
      path: `${this.#prefix}/subscriptions/${segment(subscriptionId, "subscription_id")}`,
      body: input,
      expected_status: new Set([200]),
    }, options);
    return subscriptionResponse(body, operation);
  }

  async listSubscriptions(options: ConsumerRequestOptions = {}): Promise<readonly ConsumerSubscriptionView[]> {
    const operation = "consumer.list_subscriptions";
    const body = await this.requestJson<unknown>({
      operation,
      method: "GET",
      path: `${this.#prefix}/subscriptions`,
      expected_status: new Set([200]),
      idempotent: true,
    }, options);
    return arrayResponse<ConsumerSubscriptionView>(body, operation);
  }

  async pullPage(
    subscriptionId: string,
    options: PullPageOptions & ConsumerRequestOptions = {},
  ): Promise<ConsumerPullPage> {
    const operation = "consumer.pull_page";
    const { cursor, limit, signal, timeout_ms, timeoutMs, retry } = options;
    const body = await this.requestJson<unknown>({
      operation,
      method: "GET",
      path: `${this.#prefix}/events${query({
        subscription_id: subscriptionId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit: String(limit) }),
      })}`,
      expected_status: new Set([200]),
      idempotent: true,
    }, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retry === undefined ? {} : { retry }),
    });
    return pullResponse(body, operation);
  }

  /** Short alias for consumers that call this operation simply `pull`. */
  pull(subscriptionId: string, options: PullPageOptions & ConsumerRequestOptions = {}): Promise<ConsumerPullPage> {
    return this.pullPage(subscriptionId, options);
  }

  async acknowledge(
    subscriptionId: string,
    deliveryIds: readonly string[],
    options: ConsumerAcknowledgeOptions & ConsumerRequestOptions,
  ): Promise<ConsumerAcknowledgeResult> {
    const operation = "consumer.acknowledge";
    if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) throw new Error("delivery_ids_invalid");
    const idempotencyKey = requiredIdempotencyKey(options);
    const firstDeliveryId = deliveryIds[0];
    if (firstDeliveryId === undefined) throw new Error("delivery_ids_invalid");
    const { ack_through_cursor, ackThroughCursor, signal, timeout_ms, timeoutMs, retry } = options;
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: `${this.#prefix}/events/${segment(firstDeliveryId, "delivery_id")}:ack${query({
        subscription_id: subscriptionId,
      })}`,
      body: {
        deliveryIds: [...deliveryIds],
        ...(ack_through_cursor === undefined && ackThroughCursor === undefined ? {} : { ackThroughCursor: ack_through_cursor ?? ackThroughCursor }),
        idempotencyKey,
      },
      expected_status: new Set([200]),
      idempotency_keyed: true,
    }, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retry === undefined ? {} : { retry }),
    });
    return acknowledgeResponse(body, operation);
  }

  ack(
    subscriptionId: string,
    deliveryIds: readonly string[],
    options: ConsumerAcknowledgeOptions & ConsumerRequestOptions,
  ): Promise<ConsumerAcknowledgeResult> {
    return this.acknowledge(subscriptionId, deliveryIds, options);
  }

  async listDeadLetters(
    subscriptionId: string,
    options: ListDeadLettersOptions & ConsumerRequestOptions = {},
  ): Promise<readonly ConsumerDelivery[]> {
    const operation = "consumer.list_dead_letters";
    const { limit, signal, timeout_ms, timeoutMs, retry } = options;
    const body = await this.requestJson<unknown>({
      operation,
      method: "GET",
      path: `${this.#prefix}/dead-letters${query({
        subscription_id: subscriptionId,
        ...(limit === undefined ? {} : { limit: String(limit) }),
      })}`,
      expected_status: new Set([200]),
      idempotent: true,
    }, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retry === undefined ? {} : { retry }),
    });
    return arrayResponse<ConsumerDelivery>(body, operation);
  }

  async replayDeadLetter(
    subscriptionId: string,
    deliveryId: string,
    options: ConsumerReplayOptions & ConsumerRequestOptions,
  ): Promise<ConsumerReplayResult> {
    const operation = "consumer.replay_dead_letter";
    const idempotencyKey = requiredIdempotencyKey(options);
    const { signal, timeout_ms, timeoutMs, retry } = options;
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: `${this.#prefix}/dead-letters/${segment(deliveryId, "delivery_id")}:replay${query({
        subscription_id: subscriptionId,
      })}`,
      body: { idempotencyKey },
      expected_status: new Set([200]),
      idempotency_keyed: true,
    }, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retry === undefined ? {} : { retry }),
    });
    return replayResponse(body, operation);
  }

  replay(
    subscriptionId: string,
    deliveryId: string,
    options: ConsumerReplayOptions & ConsumerRequestOptions,
  ): Promise<ConsumerReplayResult> {
    return this.replayDeadLetter(subscriptionId, deliveryId, options);
  }
}

export { ConsumerClient as AgentFeedConsumerClient };
export type { DeliveryEventType };
