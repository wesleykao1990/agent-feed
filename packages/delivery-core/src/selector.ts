import type {
  ConsumerSubscription,
  DeliveryEvent,
  NormalizedSubscriptionSelector,
} from "./types.ts";

function decimalPosition(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  return value;
}
/** Compare unbounded decimal positions without converting them to JS numbers. */
export function comparePositions(left: string, right: string): number {
  const leftValue = decimalPosition(left);
  const rightValue = decimalPosition(right);
  if (leftValue === null || rightValue === null) throw new Error("invalid_delivery_position");
  if (leftValue.length !== rightValue.length) return leftValue.length < rightValue.length ? -1 : 1;
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function assertNormalizedSelector(selector: NormalizedSubscriptionSelector): void {
  if (!selector || !Array.isArray(selector.streamIds) || selector.streamIds.length === 0) {
    throw new Error("invalid_selector_stream_ids");
  }
  if (!Array.isArray(selector.eventTypes) || selector.eventTypes.length === 0) {
    throw new Error("invalid_selector_event_types");
  }
  if (selector.findingTypes !== null && !Array.isArray(selector.findingTypes)) {
    throw new Error("invalid_selector_finding_types");
  }
  if (selector.routingTags !== null) {
    if (!Array.isArray(selector.routingTags.values) || selector.routingTags.values.length === 0) {
      throw new Error("invalid_selector_routing_tags");
    }
    if (selector.routingTags.mode !== "any" && selector.routingTags.mode !== "all") {
      throw new Error("invalid_selector_routing_tag_mode");
    }
  }
}

/**
 * Match a normalized subscription selector against a materialized event.
 * Stream, event type, finding type, and routing-tag constraints are ANDed.
 * Finding types are ORed; routing tags explicitly use any/all semantics.
 */
export function matchesSelector(
  selector: NormalizedSubscriptionSelector,
  event: DeliveryEvent,
): boolean {
  assertNormalizedSelector(selector);
  if (!selector.streamIds.includes(event.streamId)) return false;
  if (!selector.eventTypes.includes(event.eventType)) return false;
  if (event.eventType !== "finding.submitted") return true;
  if (selector.findingTypes !== null && !selector.findingTypes.includes(event.findingType ?? "")) return false;
  if (selector.routingTags === null) return true;
  const eventTags = new Set(event.routingTags);
  if (selector.routingTags.mode === "any") {
    return selector.routingTags.values.some((tag) => eventTags.has(tag));
  }
  return selector.routingTags.values.every((tag) => eventTags.has(tag));
}

/**
 * Apply subscription status, tenant isolation, quarantine exclusion, and the
 * future-only activation boundary around the normalized selector.
 */
export function matchesSubscription(
  event: DeliveryEvent,
  subscription: ConsumerSubscription,
): boolean {
  if (subscription.status !== "active") return false;
  if (!event.deliveryEligible) return false;
  if (event.tenantId !== subscription.tenantId) return false;
  if (comparePositions(event.sequence, subscription.activationPosition) <= 0) return false;
  return matchesSelector(subscription.selectors, event);
}

export function matchingSubscriptions(
  event: DeliveryEvent,
  subscriptions: readonly ConsumerSubscription[],
): readonly ConsumerSubscription[] {
  return subscriptions.filter((subscription) => matchesSubscription(event, subscription));
}

export function selectorFields(event: DeliveryEvent): {
  findingType: string | null;
  routingTags: readonly string[];
} {
  return {
    findingType: event.findingType,
    routingTags: [...event.routingTags],
  };
}
