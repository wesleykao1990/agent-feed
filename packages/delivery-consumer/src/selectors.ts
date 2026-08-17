import {
  DELIVERY_EVENT_TYPES,
  type DeliveryEventRecord,
  type DeliveryEventType,
  type NormalizedRoutingTagSelector,
  type NormalizedSubscriptionSelector,
  type RoutingTagSelectorInput,
  type SubscriptionSelectorInput,
} from "./types.ts";
import { DeliveryConsumerError } from "./types.ts";

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
  if (values.length === 0) {
    throw new DeliveryConsumerError("invalid_input", `${field}_must_not_be_empty`);
  }
  for (const value of values) assertString(value, field);
  assertUnique(values, field);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeTags(input: RoutingTagSelectorInput | undefined): NormalizedRoutingTagSelector | null {
  if (input === undefined) return null;
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

function isFindingEvent(event: DeliveryEventRecord): boolean {
  return event.eventType === "finding.submitted";
}

/**
 * Event routing is intentionally exact. Finding-type and routing-tag filters
 * apply only to finding events; run lifecycle events match stream and event
 * type, so a filtered consumer can still receive terminal lifecycle signals.
 */
export function matchesSelector(
  selector: NormalizedSubscriptionSelector,
  event: DeliveryEventRecord,
): boolean {
  if (!selector.streamIds.includes(event.streamId)) return false;
  if (!selector.eventTypes.includes(event.eventType)) return false;
  if (!isFindingEvent(event)) return true;
  if (selector.findingTypes !== null && !selector.findingTypes.includes(event.findingType ?? "")) {
    return false;
  }
  if (selector.routingTags === null) return true;
  const eventTags = new Set(event.routingTags);
  if (selector.routingTags.mode === "any") {
    return selector.routingTags.values.some((tag) => eventTags.has(tag));
  }
  return selector.routingTags.values.every((tag) => eventTags.has(tag));
}
