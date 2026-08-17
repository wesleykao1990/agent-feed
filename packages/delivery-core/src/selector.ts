import type { ConsumerSubscription, DeliveryEvent } from "./types.ts";

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function nestedFinding(event: DeliveryEvent): Record<string, unknown> | null {
  const candidate = event.payload.finding;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

function eventFindingType(event: DeliveryEvent): string | null {
  if (event.findingType !== undefined) return event.findingType;
  const finding = nestedFinding(event);
  const wire = finding?.finding_type ?? finding?.findingType;
  return typeof wire === "string" ? wire : null;
}

function eventRoutingTags(event: DeliveryEvent): readonly string[] {
  if (event.routingTags !== undefined) return event.routingTags;
  const finding = nestedFinding(event);
  return stringList(finding?.routing_tags ?? finding?.routingTags);
}

function matchesList(value: string | null, allowed: readonly string[]): boolean {
  return allowed.length === 0 || (value !== null && allowed.includes(value));
}

/**
 * Match a durable event against a subscription snapshot. Empty filters are
 * wildcards. Routing tags use any-match semantics. Terminal run events only
 * require stream scope and `includeRunEvents`.
 */
export function matchesSubscription(
  event: DeliveryEvent,
  subscription: ConsumerSubscription,
): boolean {
  if (!subscription.active) return false;
  if (!event.deliveryEligible) return false;
  if (event.tenantId !== subscription.tenantId) return false;
  if (subscription.streamIds.length > 0 && !subscription.streamIds.includes(event.streamId)) return false;

  const isRunEvent = event.findingId === null;
  if (isRunEvent) return subscription.includeRunEvents;

  if (!matchesList(eventFindingType(event), subscription.findingTypes)) return false;
  if (subscription.routingTags.length > 0) {
    const actualTags = new Set(eventRoutingTags(event));
    if (!subscription.routingTags.some((tag) => actualTags.has(tag))) return false;
  }
  return true;
}

export function matchingSubscriptions(
  event: DeliveryEvent,
  subscriptions: readonly ConsumerSubscription[],
): readonly ConsumerSubscription[] {
  return subscriptions.filter((subscription) => matchesSubscription(event, subscription));
}

/** Extract selector fields without exposing mutable payload objects. */
export function selectorFields(event: DeliveryEvent): {
  findingType: string | null;
  routingTags: readonly string[];
} {
  return {
    findingType: eventFindingType(event),
    routingTags: [...eventRoutingTags(event)],
  };
}
