import {
  DELIVERY_EVENT_TYPES,
  type DeliveryEventType,
  type NormalizedSubscriptionSelector,
  type RoutingTagSelectorInput,
  type SubscriptionSelectorInput,
} from "./types.ts";
import { DeliveryConsumerError } from "./types.ts";
import { matchesSelector as matchesCoreSelector } from "@agent-feed/delivery-core";
import type { DeliveryEvent as CoreDeliveryEvent } from "@agent-feed/delivery-core";
import type { DeliveryEventRecord } from "./types.ts";

const EVENT_TYPE_SET = new Set<string>(DELIVERY_EVENT_TYPES);

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_non_empty`);
  }
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_be_unique`);
  }
}

function sortedStrings(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_not_be_empty`);
  }
  for (const value of values) assertString(value, field);
  assertUnique(values, field);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeTags(input: RoutingTagSelectorInput | undefined): NormalizedSubscriptionSelector["routingTags"] {
  if (input === undefined) return null;
  if (!input || typeof input !== "object") {
    throw new DeliveryConsumerError("invalid_input", "routing_tags_invalid");
  }
  if (input.mode !== "any" && input.mode !== "all") {
    throw new DeliveryConsumerError("invalid_input", "routing_tag_mode_invalid");
  }
  return { mode: input.mode, values: sortedStrings(input.values, "routing_tags") };
}

export function normalizeSelector(input: SubscriptionSelectorInput): NormalizedSubscriptionSelector {
  if (!input || typeof input !== "object") {
    throw new DeliveryConsumerError("invalid_input", "selectors_required");
  }
  const streamIds = sortedStrings(input.streamIds, "stream_ids");
  const findingTypes = input.findingTypes === undefined
    ? null
    : sortedStrings(input.findingTypes, "finding_types");
  if (input.eventTypes !== undefined && !Array.isArray(input.eventTypes)) {
    throw new DeliveryConsumerError("invalid_input", "event_types_must_be_array");
  }
  const eventTypes = input.eventTypes === undefined
    ? [...DELIVERY_EVENT_TYPES]
    : [...input.eventTypes];
  if (eventTypes.length === 0) {
    throw new DeliveryConsumerError("invalid_input", "event_types_must_not_be_empty");
  }
  assertUnique(eventTypes, "event_types");
  for (const eventType of eventTypes) {
    if (!EVENT_TYPE_SET.has(eventType)) {
      throw new DeliveryConsumerError("invalid_input", `event_type_invalid:${String(eventType)}`);
    }
  }
  eventTypes.sort((left, right) => left.localeCompare(right));
  return {
    streamIds,
    findingTypes,
    routingTags: normalizeTags(input.routingTags),
    eventTypes: eventTypes as DeliveryEventType[],
  };
}

function toCoreEvent(event: DeliveryEventRecord): CoreDeliveryEvent {
  return {
    protocolVersion: "0.1",
    eventId: event.eventId,
    eventType: event.eventType,
    tenantId: "consumer-adapter",
    streamId: event.streamId,
    runId: event.runId,
    findingId: event.findingId,
    occurredAt: event.occurredAt,
    sequence: event.position,
    traceId: event.traceId,
    payload: event.payload as CoreDeliveryEvent["payload"],
    payloadHash: "adapter-payload-hash",
    findingType: event.findingType,
    routingTags: [...event.routingTags],
    deliveryEligible: true,
  };
}

/** Delegate matching to delivery-core's canonical normalized-selector logic. */
export function matchesSelector(
  selector: NormalizedSubscriptionSelector,
  event: DeliveryEventRecord,
): boolean {
  return matchesCoreSelector(selector, toCoreEvent(event));
}
