import type {
  BeginRunRequest,
  CompleteRunRequest,
  DeliveryEvent,
  Finding,
  RunBundle,
  SubmitBatchRequest,
} from "../generated/protocol.ts";

export type {
  BeginRunRequest,
  CompleteRunRequest,
  DeliveryEvent,
  Finding,
  RunBundle,
  SubmitBatchRequest,
};

export type DeliveryEventType = DeliveryEvent["event_type"];

/** The durable producer API returns a run record with its protocol envelope. */
export interface ProducerRunResponse {
  readonly run_id: string;
  readonly envelope?: import("../generated/protocol.ts").RunEnvelope;
  readonly status?: import("../generated/protocol.ts").RunEnvelope["status"];
  readonly [key: string]: unknown;
}

export type ProducerFindingResponse = Finding | {
  readonly finding: Finding;
  readonly [key: string]: unknown;
};

export interface ProducerFindingsResponse {
  readonly run_id: string;
  readonly findings: readonly ProducerFindingResponse[];
}

export interface CreateSubscriptionInput {
  readonly name: string;
  readonly selectors: SubscriptionSelectorInput;
  readonly delivery: DeliveryConfigurationInput;
}

export interface UpdateSubscriptionInput {
  readonly expectedSelectorVersion?: number;
  readonly name?: string;
  readonly selectors?: SubscriptionSelectorInput;
  readonly delivery?: DeliveryConfigurationInput;
  readonly status?: SubscriptionStatus;
}

export interface RoutingTagSelectorInput {
  readonly mode: "any" | "all";
  readonly values: readonly string[];
}

export interface SubscriptionSelectorInput {
  readonly streamIds: readonly string[];
  readonly findingTypes?: readonly string[];
  readonly routingTags?: RoutingTagSelectorInput;
  readonly eventTypes?: readonly DeliveryEventType[];
}

export type DeliveryConfigurationInput =
  | { readonly mode: "pull" }
  | { readonly mode: "webhook"; readonly endpointRef: string; readonly signingKeyId: string };

export type SubscriptionStatus = "active" | "paused" | "revoked";

/**
 * Current delivery-api response shape. `event` accepts both the protocol's
 * snake_case event object and the transport-neutral handler's camelCase view;
 * this lets the same SDK consume an HTTP adapter before/after its wire mapper
 * is deployed without inventing a second event protocol.
 */
export interface ConsumerDeliveryEventView {
  readonly eventId: string;
  readonly eventType: DeliveryEventType;
  readonly streamId: string;
  readonly runId: string;
  readonly findingId: string | null;
  readonly occurredAt: string;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
  readonly findingType?: string | null;
  readonly routingTags?: readonly string[];
  readonly position?: string;
  readonly traceId?: string | null;
}

export interface ConsumerDelivery {
  readonly deliveryId: string;
  readonly subscriptionId: string;
  readonly event: DeliveryEvent | ConsumerDeliveryEventView;
  readonly attemptCount: number;
  readonly status: "pending" | "leased" | "acknowledged" | "dead";
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

export interface ConsumerPullPage {
  readonly items: readonly ConsumerDelivery[];
  readonly nextCursor: string;
  readonly ackCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConsumerAcknowledgeResult {
  readonly acknowledgementId: string;
  readonly acknowledgedDeliveryIds: readonly string[];
  readonly ackCursor: string | null;
}

export interface ConsumerReplayResult {
  readonly replayId: string;
  readonly delivery: ConsumerDelivery;
}

export interface ConsumerSubscriptionView {
  readonly id: string;
  readonly name: string;
  readonly selectors: Record<string, unknown>;
  readonly selectorHash: string;
  readonly selectorVersion: number;
  readonly delivery: Record<string, unknown>;
  readonly status: SubscriptionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly [key: string]: unknown;
}

export interface ConsumerAcknowledgeOptions {
  readonly ack_through_cursor?: string;
  readonly ackThroughCursor?: string;
  readonly idempotency_key?: string;
  readonly idempotencyKey?: string;
}

export interface ConsumerReplayOptions {
  readonly idempotency_key?: string;
  readonly idempotencyKey?: string;
}

export interface PullPageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListDeadLettersOptions {
  readonly limit?: number;
}
