import {
  DeliveryConsumerError,
  DeliveryConsumerRepositoryError,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ConsumerAuthContext,
  type ConsumerAuthPort,
  type ConsumerScope,
  type CreateSubscriptionInput,
  type CreateSubscriptionRecord,
  type CursorCodec,
  type DeliveryConsumerRepository,
  type DeliveryConfiguration,
  type DeliveryConfigurationInput,
  type DeliveryCursorClaims,
  type DeliveryEventRecord,
  type DeadLetterRecord,
  type ListDeadLettersInput,
  type NormalizedSubscriptionSelector,
  type PayloadHasher,
  type PullPageInput,
  type PullPageResult,
  type ReplayDeadLetterInput,
  type ReplayDeadLetterRecord,
  type ReplayDeadLetterResult,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type SubscriptionView,
  type UpdateSubscriptionInput,
  type UpdateSubscriptionRecord,
} from "./types.ts";
import { normalizeSelector } from "./selectors.ts";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_DEAD_LETTER_LIMIT = 100;

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_non_empty`);
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_positive_integer`);
  }
  return value as number;
}

function position(value: unknown, field = "position"): string {
  nonEmpty(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_decimal_position`);
  }
  return value;
}

function scopeFrom(context: ConsumerAuthContext): ConsumerScope {
  nonEmpty(context.tenantId, "tenant_id");
  nonEmpty(context.consumerId, "consumer_id");
  if (!Array.isArray(context.allowedStreamIds)) {
    throw new DeliveryConsumerError("invalid_auth_context", "allowed_stream_ids_required");
  }
  if (context.allowedStreamIds.some((streamId) => streamId === "*")) {
    throw new DeliveryConsumerError("invalid_auth_context", "wildcard_stream_authorization_not_supported");
  }
  for (const streamId of context.allowedStreamIds) nonEmpty(streamId, "allowed_stream_id");
  if (new Set(context.allowedStreamIds).size !== context.allowedStreamIds.length) {
    throw new DeliveryConsumerError("invalid_auth_context", "allowed_stream_ids_must_be_unique");
  }
  if (context.allowedSubscriptionIds !== undefined) {
    if (!Array.isArray(context.allowedSubscriptionIds)) {
      throw new DeliveryConsumerError("invalid_auth_context", "allowed_subscription_ids_invalid");
    }
    for (const subscriptionId of context.allowedSubscriptionIds) nonEmpty(subscriptionId, "allowed_subscription_id");
    if (new Set(context.allowedSubscriptionIds).size !== context.allowedSubscriptionIds.length) {
      throw new DeliveryConsumerError("invalid_auth_context", "allowed_subscription_ids_must_be_unique");
    }
  }
  return { tenantId: context.tenantId, consumerId: context.consumerId };
}

function validateStatus(status: unknown): SubscriptionStatus {
  if (status !== "active" && status !== "paused" && status !== "revoked") {
    throw new DeliveryConsumerError("invalid_input", "subscription_status_invalid");
  }
  return status;
}

function validateName(name: unknown): string {
  nonEmpty(name, "subscription_name");
  if (name.length > 100) {
    throw new DeliveryConsumerError("invalid_input", "subscription_name_too_long");
  }
  return name;
}

function normalizeDelivery(input: DeliveryConfigurationInput): DeliveryConfiguration {
  if (!input || (input.mode !== "pull" && input.mode !== "webhook")) {
    throw new DeliveryConsumerError("invalid_input", "delivery_mode_invalid");
  }
  const endpointRef = input.endpointRef ?? null;
  const signingKeyId = input.signingKeyId ?? null;
  if (input.mode === "webhook") {
    nonEmpty(endpointRef, "endpoint_ref");
    nonEmpty(signingKeyId, "signing_key_id");
  } else if (endpointRef !== null || signingKeyId !== null) {
    throw new DeliveryConsumerError("invalid_input", "pull_delivery_cannot_have_webhook_configuration");
  }
  return { mode: input.mode, endpointRef, signingKeyId };
}

function authorizeSelector(
  selector: NormalizedSubscriptionSelector,
  context: ConsumerAuthContext,
): void {
  const allowed = new Set(context.allowedStreamIds);
  const unauthorized = selector.streamIds.find((streamId) => !allowed.has(streamId));
  if (unauthorized !== undefined) {
    throw new DeliveryConsumerError("unauthorized_stream", `stream_not_allowed:${unauthorized}`);
  }
}

function toView(record: SubscriptionRecord): SubscriptionView {
  const {
    tenantId: _tenantId,
    consumerId: _consumerId,
    activationPosition: _activationPosition,
    ...view
  } = record;
  void _tenantId;
  void _consumerId;
  void _activationPosition;
  return structuredClone(view);
}

function isRepositoryError(value: unknown): value is DeliveryConsumerRepositoryError {
  return value instanceof DeliveryConsumerRepositoryError;
}

function rethrowRepositoryError(value: unknown): never {
  if (isRepositoryError(value)) {
    if (value.code === "not_found" || value.code === "scope_violation") {
      throw new DeliveryConsumerError("not_found");
    }
    if (value.code === "idempotency_payload_conflict") {
      throw new DeliveryConsumerError("idempotency_payload_conflict");
    }
    if (value.code === "subscription_conflict") {
      throw new DeliveryConsumerError("subscription_conflict");
    }
    throw new DeliveryConsumerError("invalid_state", value.message);
  }
  throw new DeliveryConsumerError("invalid_state", "repository_operation_failed");
}

function validateCursorClaims(
  claims: DeliveryCursorClaims,
  expected: Pick<DeliveryCursorClaims, "version" | "tenantId" | "consumerId" | "subscriptionId" | "selectorVersion">,
  nowSeconds: number,
): string {
  if (
    !claims
    || claims.version !== 1
    || claims.tenantId !== expected.tenantId
    || claims.consumerId !== expected.consumerId
    || claims.subscriptionId !== expected.subscriptionId
    || claims.selectorVersion !== expected.selectorVersion
  ) {
    throw new DeliveryConsumerError("cursor_scope_mismatch");
  }
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= nowSeconds) {
    throw new DeliveryConsumerError("cursor_invalid");
  }
  return position(claims.position, "cursor_position");
}

function cursorClaims(
  scope: ConsumerScope,
  subscription: SubscriptionRecord,
  cursorPosition: string,
  expiresAt: number,
): DeliveryCursorClaims {
  return {
    version: 1,
    tenantId: scope.tenantId,
    consumerId: scope.consumerId,
    subscriptionId: subscription.id,
    selectorVersion: subscription.selectorVersion,
    position: position(cursorPosition),
    expiresAt,
  };
}

function sortedIds(values: readonly string[], field: string): string[] {
  if (values.length === 0) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_not_be_empty`);
  }
  const result = [...values];
  for (const value of result) nonEmpty(value, field);
  if (new Set(result).size !== result.length) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_unique`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export class DeliveryConsumerService {
  readonly #repository: DeliveryConsumerRepository;
  readonly #auth: ConsumerAuthPort;
  readonly #cursorCodec: CursorCodec;
  readonly #hasher: PayloadHasher;
  readonly #nowSeconds: () => number;
  readonly #cursorTtlSeconds: number;

  constructor(options: {
    repository: DeliveryConsumerRepository;
    auth: ConsumerAuthPort;
    cursorCodec: CursorCodec;
    payloadHasher: PayloadHasher;
    nowSeconds?: () => number;
    cursorTtlSeconds?: number;
  }) {
    this.#repository = options.repository;
    this.#auth = options.auth;
    this.#cursorCodec = options.cursorCodec;
    this.#hasher = options.payloadHasher;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#cursorTtlSeconds = options.cursorTtlSeconds ?? 900;
    if (!Number.isSafeInteger(this.#cursorTtlSeconds) || this.#cursorTtlSeconds < 1) {
      throw new DeliveryConsumerError("invalid_input", "cursor_ttl_invalid");
    }
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionView> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const selector = normalizeSelector(input.selectors);
    authorizeSelector(selector, context);
    const record: CreateSubscriptionRecord = {
      scope,
      name: validateName(input.name),
      selectors: selector,
      selectorHash: this.#hasher.hash(selector),
      delivery: normalizeDelivery(input.delivery),
      activation: "future",
    };
    try {
      const created = await this.#repository.createSubscription(record);
      this.#assertRecordScope(created, scope);
      return toView(created);
    } catch (error) {
      rethrowRepositoryError(error);
    }
  }

  async updateSubscription(input: UpdateSubscriptionInput): Promise<SubscriptionView> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const current = await this.#requireSubscription(scope, context, input.subscriptionId);
    const selector = input.selectors === undefined ? undefined : normalizeSelector(input.selectors);
    if (selector !== undefined) authorizeSelector(selector, context);
    if (input.expectedSelectorVersion !== undefined && input.expectedSelectorVersion !== current.selectorVersion) {
      throw new DeliveryConsumerError("subscription_conflict", "selector_version_conflict");
    }
    const selectorChanged = selector !== undefined && this.#hasher.hash(selector) !== current.selectorHash;
    const update: UpdateSubscriptionRecord = {
      scope,
      subscriptionId: current.id,
      expectedSelectorVersion: current.selectorVersion,
      ...(input.name === undefined ? {} : { name: validateName(input.name) }),
      ...(selectorChanged && selector !== undefined
        ? {
          selectors: selector,
          selectorHash: this.#hasher.hash(selector),
        }
        : {}),
      ...(input.delivery === undefined ? {} : { delivery: normalizeDelivery(input.delivery) }),
      ...(input.status === undefined ? {} : { status: validateStatus(input.status) }),
      activation: selectorChanged ? "future" : "unchanged",
    };
    try {
      const updated = await this.#repository.updateSubscription(update);
      if (!updated) throw new DeliveryConsumerError("not_found");
      this.#assertRecordScope(updated, scope);
      return toView(updated);
    } catch (error) {
      rethrowRepositoryError(error);
    }
  }

  async listSubscriptions(): Promise<SubscriptionView[]> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const allowedIds = context.allowedSubscriptionIds === undefined
      ? null
      : new Set(context.allowedSubscriptionIds);
    let records: SubscriptionRecord[];
    try {
      records = await this.#repository.listSubscriptions(scope);
    } catch (error) {
      rethrowRepositoryError(error);
    }
    return records
      .filter((record) => this.#recordInScope(record, scope))
      .filter((record) => allowedIds === null || allowedIds.has(record.id))
      .filter((record) => this.#selectorAllowed(record.selectors, context))
      .map(toView);
  }

  async pullPage(input: PullPageInput): Promise<PullPageResult> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const subscription = await this.#requireSubscription(scope, context, input.subscriptionId);
    if (subscription.status === "revoked") throw new DeliveryConsumerError("not_found");
    const limit = input.limit === undefined ? DEFAULT_PAGE_LIMIT : positiveInteger(input.limit, "limit");
    if (limit > MAX_PAGE_LIMIT) throw new DeliveryConsumerError("invalid_input", "limit_too_large");
    // Materialized deliveries already enforce the subscription/version's
    // future-only activation boundary. Start an un-cursored read at zero so a
    // selector update cannot strand an unacknowledged row from an older
    // version; acknowledged rows are excluded by the repository.
    let afterPosition = "0";
    if (input.cursor !== undefined) {
      const claims = this.#decodeCursor(input.cursor);
      afterPosition = validateCursorClaims(claims, {
        version: 1,
        tenantId: scope.tenantId,
        consumerId: scope.consumerId,
        subscriptionId: subscription.id,
        selectorVersion: subscription.selectorVersion,
      }, this.#nowSeconds());
    }
    let page;
    try {
      page = await this.#repository.pullPage({
        scope,
        subscriptionId: subscription.id,
        selector: subscription.selectors,
        selectorVersion: subscription.selectorVersion,
        afterPosition,
        limit,
      });
    } catch (error) {
      rethrowRepositoryError(error);
    }
    const nextPosition = position(page.nextPosition, "next_position");
    const nextCursor = this.#encodeCursor(scope, subscription, nextPosition);
    const ackCursor = page.ackPosition === null
      ? null
      : this.#encodeCursor(scope, subscription, position(page.ackPosition, "ack_position"));
    return {
      items: structuredClone(page.items),
      nextCursor,
      ackCursor,
      hasMore: page.hasMore,
    };
  }

  async acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const subscription = await this.#requireSubscription(scope, context, input.subscriptionId);
    const deliveryIds = sortedIds(input.deliveryIds, "delivery_ids");
    nonEmpty(input.idempotencyKey, "idempotency_key");
    let ackThroughPosition: string | null = null;
    if (input.ackThroughCursor !== undefined) {
      const claims = this.#decodeCursor(input.ackThroughCursor);
      ackThroughPosition = validateCursorClaims(claims, {
        version: 1,
        tenantId: scope.tenantId,
        consumerId: scope.consumerId,
        subscriptionId: subscription.id,
        selectorVersion: subscription.selectorVersion,
      }, this.#nowSeconds());
    }
    const payloadHash = this.#hasher.hash({
      subscriptionId: subscription.id,
      deliveryIds,
      ackThroughPosition,
    });
    let result;
    try {
      result = await this.#repository.acknowledge({
        scope,
        subscriptionId: subscription.id,
        deliveryIds,
        ackThroughPosition,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
      });
    } catch (error) {
      rethrowRepositoryError(error);
    }
    return {
      acknowledgementId: result.acknowledgementId,
      acknowledgedDeliveryIds: [...result.acknowledgedDeliveryIds],
      ackCursor: result.ackPosition === null
        ? null
        : this.#encodeCursor(scope, subscription, position(result.ackPosition, "ack_position")),
    };
  }

  async listDeadLetters(input: ListDeadLettersInput): Promise<DeadLetterRecord[]> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    await this.#requireSubscription(scope, context, input.subscriptionId);
    const limit = input.limit === undefined ? DEFAULT_PAGE_LIMIT : positiveInteger(input.limit, "limit");
    if (limit > MAX_DEAD_LETTER_LIMIT) throw new DeliveryConsumerError("invalid_input", "limit_too_large");
    try {
      const records = await this.#repository.listDeadLetters({ scope, subscriptionId: input.subscriptionId, limit });
      return structuredClone(records);
    } catch (error) {
      rethrowRepositoryError(error);
    }
  }

  async replayDeadLetter(input: ReplayDeadLetterInput): Promise<ReplayDeadLetterResult> {
    const context = this.#auth.getContext();
    const scope = scopeFrom(context);
    const subscription = await this.#requireSubscription(scope, context, input.subscriptionId);
    nonEmpty(input.deliveryId, "delivery_id");
    nonEmpty(input.idempotencyKey, "idempotency_key");
    const record: ReplayDeadLetterRecord = {
      scope,
      subscriptionId: subscription.id,
      deliveryId: input.deliveryId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: this.#hasher.hash({
        subscriptionId: subscription.id,
        deliveryId: input.deliveryId,
      }),
    };
    try {
      const result = await this.#repository.replayDeadLetter(record);
      return { replayId: result.replayId, delivery: structuredClone(result.delivery) };
    } catch (error) {
      rethrowRepositoryError(error);
    }
  }

  #decodeCursor(token: string): DeliveryCursorClaims {
    nonEmpty(token, "cursor");
    try {
      return this.#cursorCodec.decode(token);
    } catch {
      throw new DeliveryConsumerError("cursor_invalid");
    }
  }

  #encodeCursor(scope: ConsumerScope, subscription: SubscriptionRecord, cursorPosition: string): string {
    try {
      return this.#cursorCodec.encode(cursorClaims(
        scope,
        subscription,
        cursorPosition,
        this.#nowSeconds() + this.#cursorTtlSeconds,
      ));
    } catch {
      throw new DeliveryConsumerError("cursor_invalid");
    }
  }

  async #requireSubscription(
    scope: ConsumerScope,
    context: ConsumerAuthContext,
    subscriptionId: string,
  ): Promise<SubscriptionRecord> {
    nonEmpty(subscriptionId, "subscription_id");
    if (context.allowedSubscriptionIds !== undefined && !context.allowedSubscriptionIds.includes(subscriptionId)) {
      throw new DeliveryConsumerError("not_found");
    }
    let record: SubscriptionRecord | null;
    try {
      record = await this.#repository.getSubscription(scope, subscriptionId);
    } catch (error) {
      rethrowRepositoryError(error);
    }
    if (!record || !this.#recordInScope(record, scope) || !this.#selectorAllowed(record.selectors, context)) {
      throw new DeliveryConsumerError("not_found");
    }
    return record;
  }

  #recordInScope(record: SubscriptionRecord, scope: ConsumerScope): boolean {
    return record.tenantId === scope.tenantId && record.consumerId === scope.consumerId;
  }

  #selectorAllowed(selector: NormalizedSubscriptionSelector, context: ConsumerAuthContext): boolean {
    const allowed = new Set(context.allowedStreamIds);
    return selector.streamIds.every((streamId) => allowed.has(streamId));
  }

  #assertRecordScope(record: SubscriptionRecord, scope: ConsumerScope): void {
    if (!this.#recordInScope(record, scope)) {
      throw new DeliveryConsumerError("invalid_state", "repository_scope_violation");
    }
  }
}

/** Exposed for adapter tests without exposing the service's private scope helpers. */
export type ConsumerDeliveryEvent = DeliveryEventRecord;
