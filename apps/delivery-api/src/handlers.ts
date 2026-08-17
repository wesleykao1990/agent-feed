import {
  DeliveryConsumerError,
  DeliveryConsumerService,
  type AcknowledgeInput,
  type CreateSubscriptionInput,
  type DeliveryConfigurationInput,
  type PullPageInput,
  type ReplayDeadLetterInput,
  type SubscriptionSelectorInput,
  type UpdateSubscriptionInput,
} from "@agent-feed/delivery-consumer";
import type {
  DeliveryApiDependencies,
  DeliveryApiRequest,
  DeliveryApiResponse,
} from "./types.ts";

class ApiInputError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
    this.name = "ApiInputError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiInputError(`${field}_must_be_object`);
  }
  return value as Record<string, unknown>;
}

function rejectScopeFields(value: Record<string, unknown>): void {
  for (const key of ["tenantId", "tenant_id", "consumerId", "consumer_id"]) {
    if (Object.hasOwn(value, key)) throw new ApiInputError("scope_must_come_from_credential");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ApiInputError(`${field}_must_be_non_empty`);
  }
  return value;
}

function params(request: DeliveryApiRequest): Record<string, unknown> {
  return { ...(request.params ?? {}) };
}

function subscriptionId(request: DeliveryApiRequest): string {
  return requiredString(params(request).subscriptionId, "subscription_id");
}

function bodyRecord(request: DeliveryApiRequest): Record<string, unknown> {
  const body = record(request.body, "body");
  rejectScopeFields(body);
  return body;
}

function selector(value: unknown): SubscriptionSelectorInput {
  const input = record(value, "selectors");
  const streamIds = input.streamIds;
  if (!Array.isArray(streamIds)) throw new ApiInputError("stream_ids_must_be_array");
  const result: SubscriptionSelectorInput = { streamIds: [...streamIds] as string[] };
  if (input.findingTypes !== undefined) {
    if (!Array.isArray(input.findingTypes)) throw new ApiInputError("finding_types_must_be_array");
    (result as { findingTypes?: readonly string[] }).findingTypes = [...input.findingTypes] as string[];
  }
  if (input.routingTags !== undefined) {
    const tags = record(input.routingTags, "routing_tags");
    if (tags.mode !== "any" && tags.mode !== "all") throw new ApiInputError("routing_tag_mode_invalid");
    if (!Array.isArray(tags.values)) throw new ApiInputError("routing_tags_must_be_array");
    (result as { routingTags?: { mode: "any" | "all"; values: readonly string[] } }).routingTags = {
      mode: tags.mode,
      values: [...tags.values] as string[],
    };
  }
  if (input.eventTypes !== undefined) {
    if (!Array.isArray(input.eventTypes)) throw new ApiInputError("event_types_must_be_array");
    (result as { eventTypes?: readonly string[] }).eventTypes = [...input.eventTypes] as never;
  }
  return result;
}

function delivery(value: unknown): DeliveryConfigurationInput {
  const input = record(value, "delivery");
  if (input.mode !== "pull" && input.mode !== "webhook") {
    throw new ApiInputError("delivery_mode_invalid");
  }
  if (input.mode === "pull") {
    if (input.endpointRef !== undefined || input.signingKeyId !== undefined) {
      throw new ApiInputError("pull_delivery_cannot_have_webhook_configuration");
    }
    return { mode: "pull" };
  }
  return {
    mode: "webhook",
    endpointRef: input.endpointRef as string,
    signingKeyId: input.signingKeyId as string,
  };
}

function parseCreate(request: DeliveryApiRequest): CreateSubscriptionInput {
  const input = bodyRecord(request);
  return {
    name: input.name as string,
    selectors: selector(input.selectors),
    delivery: delivery(input.delivery),
  };
}

function parseUpdate(request: DeliveryApiRequest): UpdateSubscriptionInput {
  const input = bodyRecord(request);
  const result: UpdateSubscriptionInput = { subscriptionId: subscriptionId(request) };
  if (input.expectedSelectorVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedSelectorVersion)) throw new ApiInputError("expected_selector_version_invalid");
    result.expectedSelectorVersion = input.expectedSelectorVersion as number;
  }
  if (input.name !== undefined) result.name = input.name as string;
  if (input.selectors !== undefined) result.selectors = selector(input.selectors);
  if (input.delivery !== undefined) result.delivery = delivery(input.delivery);
  if (input.status !== undefined) result.status = input.status as UpdateSubscriptionInput["status"];
  return result;
}

function queryValue(request: DeliveryApiRequest, key: string): unknown {
  return request.query === undefined ? undefined : request.query[key];
}

function optionalLimit(request: DeliveryApiRequest): number | undefined {
  const value = queryValue(request, "limit");
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new ApiInputError("limit_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ApiInputError("limit_invalid");
  return parsed;
}

function parsePull(request: DeliveryApiRequest): PullPageInput {
  const cursor = queryValue(request, "cursor");
  if (cursor !== undefined && typeof cursor !== "string") throw new ApiInputError("cursor_invalid");
  const limit = optionalLimit(request);
  return {
    subscriptionId: subscriptionId(request),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseAcknowledge(request: DeliveryApiRequest): AcknowledgeInput {
  const input = bodyRecord(request);
  if (!Array.isArray(input.deliveryIds)) throw new ApiInputError("delivery_ids_must_be_array");
  return {
    subscriptionId: subscriptionId(request),
    deliveryIds: [...input.deliveryIds] as string[],
    ...(input.ackThroughCursor === undefined ? {} : { ackThroughCursor: input.ackThroughCursor as string }),
    idempotencyKey: input.idempotencyKey as string,
  };
}

function parseReplay(request: DeliveryApiRequest): ReplayDeadLetterInput {
  const input = bodyRecord(request);
  return {
    subscriptionId: subscriptionId(request),
    deliveryId: requiredString(params(request).deliveryId, "delivery_id"),
    idempotencyKey: input.idempotencyKey as string,
  };
}

function errorResponse(error: unknown): DeliveryApiResponse {
  if (error instanceof ApiInputError) return { status: 400, body: { error: "invalid_input" } };
  if (error instanceof DeliveryConsumerError) {
    const status = error.code === "not_found"
      ? 404
      : error.code === "unauthorized_stream"
        ? 403
        : error.code === "idempotency_payload_conflict" || error.code === "subscription_conflict"
          ? 409
          : error.code === "invalid_auth_context"
            ? 401
            : error.code === "invalid_state"
              ? 409
              : 400;
    return { status, body: { error: error.code } };
  }
  return { status: 500, body: { error: "internal_error" } };
}

export class DeliveryApiHandlers {
  readonly #dependencies: DeliveryApiDependencies;

  constructor(dependencies: DeliveryApiDependencies) {
    this.#dependencies = dependencies;
  }

  async createSubscription(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.createSubscription(parseCreate(request)), 201);
  }

  async updateSubscription(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.updateSubscription(parseUpdate(request)), 200);
  }

  async listSubscriptions(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.listSubscriptions(), 200);
  }

  async pullPage(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.pullPage(parsePull(request)), 200);
  }

  async acknowledge(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.acknowledge(parseAcknowledge(request)), 200);
  }

  async listDeadLetters(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.listDeadLetters({ subscriptionId: subscriptionId(request), limit: optionalLimit(request) }), 200);
  }

  async replayDeadLetter(request: DeliveryApiRequest): Promise<DeliveryApiResponse> {
    return this.#invoke(request, (service) => service.replayDeadLetter(parseReplay(request)), 200);
  }

  async #invoke(
    request: DeliveryApiRequest,
    operation: (service: DeliveryConsumerService) => Promise<unknown>,
    successStatus: number,
  ): Promise<DeliveryApiResponse> {
    let context;
    try {
      context = await this.#dependencies.credentials.resolve(request.credential);
    } catch {
      return { status: 401, body: { error: "unauthorized" } };
    }
    const service = new DeliveryConsumerService({
      repository: this.#dependencies.repository,
      auth: { getContext: () => structuredClone(context) },
      cursorCodec: this.#dependencies.cursorCodec,
      payloadHasher: this.#dependencies.payloadHasher,
      nowSeconds: this.#dependencies.nowSeconds,
    });
    try {
      return { status: successStatus, body: await operation(service) };
    } catch (error) {
      return errorResponse(error);
    }
  }
}
