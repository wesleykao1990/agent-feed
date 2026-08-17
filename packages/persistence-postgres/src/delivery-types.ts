import type {
  AcknowledgeInput as CoreAcknowledgeInput,
  ConsumerSubscription as CoreConsumerSubscription,
  DeadLetterInput as CoreDeadLetterInput,
  DeliveryClaim as CoreDeliveryClaim,
  DeliveryEndpoint as CoreDeliveryEndpoint,
  DeliveryError as CoreDeliveryError,
  DeliveryEvent as CoreDeliveryEvent,
  DeliveryEventType as CoreDeliveryEventType,
  DeliveryJob as CoreDeliveryJob,
  DeliveryRepository,
  LeaseClaimInput as CoreLeaseClaimInput,
  LeaseOutcomeInput as CoreLeaseOutcomeInput,
  LeaseTransitionResult as CoreLeaseTransitionResult,
  NormalizedRoutingTagSelector,
  NormalizedSubscriptionSelector,
  PullInput as CorePullInput,
  PullPage as CorePullPage,
  RetryInput as CoreRetryInput,
  ReplayInput as CoreReplayInput,
} from "@agent-feed/delivery-core";
import type { JsonObject, JsonValue } from "./types.ts";

export type DeliveryEventType = CoreDeliveryEventType;
export type DeliveryState = CoreDeliveryJob["state"];
export type SubscriptionStatus = CoreConsumerSubscription["status"];

export interface RoutingTagSelector extends NormalizedRoutingTagSelector {}
export interface SubscriptionSelectors extends NormalizedSubscriptionSelector {}
export interface DeliveryEndpoint extends CoreDeliveryEndpoint {}

export interface ConsumerSubscription extends CoreConsumerSubscription {
  selectors: SubscriptionSelectors;
  activationPosition: string;
}

export interface DeliveryEvent extends CoreDeliveryEvent {
  /** Database UUID when findingId is a wire/domain key rather than a UUID. */
  databaseFindingId?: string | null;
}

export interface DeliveryError extends CoreDeliveryError {}

export interface DeliveryJob extends CoreDeliveryJob {
  /** Pull adapters may attach the immutable event for response serialization. */
  event?: DeliveryEvent;
}

export interface DeliveryClaim {
  job: DeliveryJob;
  event: DeliveryEvent;
  subscription: ConsumerSubscription;
}

export type LeaseClaimInput = CoreLeaseClaimInput;
export type LeaseOutcomeInput = CoreLeaseOutcomeInput;
export type LeaseTransitionResult =
  | { applied: true; job: DeliveryJob }
  | { applied: false; reason: "stale_lease" | "already_terminal" | "not_found"; job: DeliveryJob | null };
export type AcknowledgeInput = CoreAcknowledgeInput;
export type RetryInput = CoreRetryInput;
export type DeadLetterInput = CoreDeadLetterInput;

export interface ReplayInput extends CoreReplayInput {
  requestedBy?: string;
}

export interface PullInput extends Omit<CorePullInput, "selectorVersion"> {
  selectorVersion: number;
}

export interface PullPage extends Omit<CorePullPage, "deliveries"> {
  deliveries: readonly DeliveryJob[];
}

export interface SubscriptionInput {
  tenantId: string;
  consumerId: string;
  subscriptionId?: string;
  selectorVersion?: number;
  streamIds: string[];
  findingTypes?: string[] | null;
  routingTags?: RoutingTagSelector | null;
  eventTypes?: DeliveryEventType[];
  includeRunEvents?: boolean;
  startsAt?: string;
  active?: boolean;
  deliveryMode: "webhook" | "pull";
  endpoint?: Partial<DeliveryEndpoint> | null;
}

/** Accept unknown JSON from pg while keeping the public payload type strict. */
export function asDeliveryPayload(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {} as JsonObject;
}

export type DeliveryJson = JsonValue;
export type { DeliveryRepository };
