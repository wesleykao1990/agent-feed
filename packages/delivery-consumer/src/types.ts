/**
 * Pure consumer-delivery application contracts.
 *
 * The repository is deliberately an adapter seam: this package does not know
 * whether the durable implementation is PostgreSQL, a queue, or a test fake.
 */

import {
  DELIVERY_EVENT_TYPES,
  type DeliveryEventType,
  type NormalizedRoutingTagSelector,
  type NormalizedSubscriptionSelector,
  type SubscriptionStatus,
  type CursorCodec as CoreCursorCodec,
  type CursorPayload as CoreCursorPayload,
} from "@agent-feed/delivery-core";

export { DELIVERY_EVENT_TYPES };
export type {
  DeliveryEventType,
  NormalizedRoutingTagSelector,
  NormalizedSubscriptionSelector,
  SubscriptionStatus,
};
export type CursorCodec = CoreCursorCodec;
export type DeliveryCursorClaims = CoreCursorPayload;

export type DeliveryMode = "pull" | "webhook";

export interface ConsumerAuthContext {
  /** Both values come from the authenticated credential, never a request body. */
  tenantId: string;
  consumerId: string;
  /** Exact stream allowlist. Wildcards are intentionally unsupported here. */
  allowedStreamIds: readonly string[];
  /** Optional narrower allowlist for deployments that issue per-subscription credentials. */
  allowedSubscriptionIds?: readonly string[];
}

export interface ConsumerAuthPort {
  getContext(): ConsumerAuthContext;
}

export interface ConsumerScope {
  tenantId: string;
  consumerId: string;
}

export interface PayloadHasher {
  /** Must be deterministic for semantically identical payloads. */
  hash(value: unknown): string;
}

export interface RoutingTagSelectorInput {
  mode: "any" | "all";
  values: readonly string[];
}

export interface SubscriptionSelectorInput {
  /** Required exact stream allowlist. */
  streamIds: readonly string[];
  /** Omitted means any finding type; values are ORed. */
  findingTypes?: readonly string[];
  /** Omitted means no routing-tag constraint. */
  routingTags?: RoutingTagSelectorInput;
  /** Omitted means all protocol event types. */
  eventTypes?: readonly DeliveryEventType[];
}

export interface PullDeliveryConfigurationInput {
  mode: "pull";
  /** Pull delivery has no endpoint or signing key. */
  endpointRef?: never;
  signingKeyId?: never;
}

export interface WebhookDeliveryConfigurationInput {
  mode: "webhook";
  /** Reference to a separately managed endpoint, not a secret or credential. */
  endpointRef: string;
  /** Required key reference; key material stays outside this package. */
  signingKeyId: string;
}

export type DeliveryConfigurationInput =
  | PullDeliveryConfigurationInput
  | WebhookDeliveryConfigurationInput;

export interface DeliveryConfiguration {
  mode: DeliveryMode;
  endpointRef: string | null;
  signingKeyId: string | null;
}

export interface SubscriptionRecord {
  id: string;
  tenantId: string;
  consumerId: string;
  name: string;
  selectors: NormalizedSubscriptionSelector;
  selectorHash: string;
  selectorVersion: number;
  delivery: DeliveryConfiguration;
  status: SubscriptionStatus;
  /** Tenant-global position captured atomically at creation; activation is future-only. */
  activationPosition: string;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionView = Omit<
  SubscriptionRecord,
  "tenantId" | "consumerId" | "activationPosition"
>;

export interface CreateSubscriptionRecord {
  scope: ConsumerScope;
  name: string;
  selectors: NormalizedSubscriptionSelector;
  selectorHash: string;
  delivery: DeliveryConfiguration;
  /** Repository captures the current outbox position transactionally. */
  activation: "future";
}

export interface UpdateSubscriptionRecord {
  scope: ConsumerScope;
  subscriptionId: string;
  expectedSelectorVersion: number;
  name?: string;
  selectors?: NormalizedSubscriptionSelector;
  selectorHash?: string;
  delivery?: DeliveryConfiguration;
  status?: SubscriptionStatus;
  /** Selector changes are effective only for events after the transaction boundary. */
  activation: "future" | "unchanged";
}

export interface DeliveryEventRecord {
  eventId: string;
  eventType: DeliveryEventType;
  streamId: string;
  runId: string;
  findingId: string | null;
  occurredAt: string;
  attempt: number;
  payload: Record<string, unknown>;
  /** Materialized routing metadata; terminal events use null/empty values. */
  findingType: string | null;
  routingTags: readonly string[];
  /** Tenant-global monotonic decimal position, shared across streams. */
  position: string;
  traceId: string | null;
}

export interface SubscriptionDeliveryRecord {
  deliveryId: string;
  subscriptionId: string;
  event: DeliveryEventRecord;
  attemptCount: number;
  status: "pending" | "leased" | "acknowledged" | "dead";
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface PullPageQuery {
  scope: ConsumerScope;
  subscriptionId: string;
  selector: NormalizedSubscriptionSelector;
  selectorVersion: number;
  afterPosition: string;
  limit: number;
}

export interface PullPageRepositoryResult {
  items: SubscriptionDeliveryRecord[];
  nextPosition: string;
  hasMore: boolean;
  /** Highest contiguous acknowledged position, when the adapter can provide it. */
  ackPosition: string | null;
}

export interface AcknowledgeRecord {
  scope: ConsumerScope;
  subscriptionId: string;
  deliveryIds: string[];
  ackThroughPosition: string | null;
  idempotencyKey: string;
  payloadHash: string;
}

export interface AcknowledgeRepositoryResult {
  acknowledgementId: string;
  acknowledgedDeliveryIds: string[];
  ackPosition: string | null;
}

export interface DeadLetterRecord extends SubscriptionDeliveryRecord {
  deadAt: string;
}

export interface DeadLetterQuery {
  scope: ConsumerScope;
  subscriptionId: string;
  limit: number;
}

export interface ReplayDeadLetterRecord {
  scope: ConsumerScope;
  subscriptionId: string;
  deliveryId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface ReplayRepositoryResult {
  replayId: string;
  delivery: SubscriptionDeliveryRecord;
}

export type RepositoryErrorCode =
  | "not_found"
  | "idempotency_payload_conflict"
  | "subscription_conflict"
  | "invalid_state"
  | "scope_violation";

export class DeliveryConsumerRepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string = code) {
    super(message);
    this.name = "DeliveryConsumerRepositoryError";
    this.code = code;
  }
}

export interface DeliveryConsumerRepository {
  createSubscription(input: CreateSubscriptionRecord): Promise<SubscriptionRecord>;
  getSubscription(scope: ConsumerScope, subscriptionId: string): Promise<SubscriptionRecord | null>;
  listSubscriptions(scope: ConsumerScope): Promise<SubscriptionRecord[]>;
  updateSubscription(input: UpdateSubscriptionRecord): Promise<SubscriptionRecord | null>;
  pullPage(input: PullPageQuery): Promise<PullPageRepositoryResult>;
  acknowledge(input: AcknowledgeRecord): Promise<AcknowledgeRepositoryResult>;
  listDeadLetters(input: DeadLetterQuery): Promise<DeadLetterRecord[]>;
  replayDeadLetter(input: ReplayDeadLetterRecord): Promise<ReplayRepositoryResult>;
}

export interface CreateSubscriptionInput {
  name: string;
  selectors: SubscriptionSelectorInput;
  delivery: DeliveryConfigurationInput;
}

export interface UpdateSubscriptionInput {
  subscriptionId: string;
  expectedSelectorVersion?: number;
  name?: string;
  selectors?: SubscriptionSelectorInput;
  delivery?: DeliveryConfigurationInput;
  status?: SubscriptionStatus;
}

export interface PullPageInput {
  subscriptionId: string;
  cursor?: string;
  limit?: number;
}

export interface PullPageResult {
  items: SubscriptionDeliveryRecord[];
  nextCursor: string;
  ackCursor: string | null;
  hasMore: boolean;
}

export interface AcknowledgeInput {
  subscriptionId: string;
  deliveryIds: readonly string[];
  ackThroughCursor?: string;
  idempotencyKey: string;
}

export interface AcknowledgeResult {
  acknowledgementId: string;
  acknowledgedDeliveryIds: string[];
  ackCursor: string | null;
}

export interface ListDeadLettersInput {
  subscriptionId: string;
  limit?: number;
}

export interface ReplayDeadLetterInput {
  subscriptionId: string;
  deliveryId: string;
  idempotencyKey: string;
}

export interface ReplayDeadLetterResult {
  replayId: string;
  delivery: SubscriptionDeliveryRecord;
}

export type DeliveryConsumerErrorCode =
  | "invalid_input"
  | "invalid_auth_context"
  | "unauthorized_stream"
  | "not_found"
  | "cursor_invalid"
  | "cursor_scope_mismatch"
  | "idempotency_payload_conflict"
  | "subscription_conflict"
  | "invalid_state";

export class DeliveryConsumerError extends Error {
  readonly code: DeliveryConsumerErrorCode;

  constructor(code: DeliveryConsumerErrorCode, message: string = code) {
    super(message);
    this.name = "DeliveryConsumerError";
    this.code = code;
  }
}
