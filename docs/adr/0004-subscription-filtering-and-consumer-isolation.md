# ADR-0004: Subscription filtering and consumer isolation

- Status: Accepted and implemented in the M2 repository
- Date: 2026-08-18
- Scope: Consumer subscriptions and routing

## Context

M2 must support subscriptions by stream, finding type, and routing tag while
ensuring that one consumer cannot inspect or acknowledge another consumer's
feed. The current M1 schema has no consumer, tenant, subscription, attempt, or
acknowledgement scope.

Delivery events use a generic protocol. Finding type and routing tags are
available in finding payloads, while terminal events have no finding type.

## Decision

Every subscription has an authenticated `consumer_id` and tenant scope. Every
delivery attempt, acknowledgement, pull cursor, and dead-letter record carries
the subscription identity and is authorized through that identity.

Routing is deterministic:

- stream IDs match exactly by default;
- finding-type predicates apply only to finding events;
- routing-tag matching uses one documented all/any policy;
- terminal events route by stream and are not assigned a synthetic finding
  type.

The implementation must choose and document whether a newly created
subscription receives only future events or can read historical events through
an explicitly requested pull cursor. A subscription cannot obtain historical
events merely by changing another consumer's cursor.

## Rejected alternatives

- Filter only in the worker after listing all events: risks cross-consumer data
  exposure and makes authorization easy to omit.
- Use an unscoped `consumer_id` query parameter as authorization: callers can
  impersonate another consumer.
- Treat terminal events as a finding type: invents semantics not present in the
  protocol.
- Use SQL text wildcards as an undocumented routing language: ambiguous and
  hard to secure.

## Consequences

Subscriptions require explicit scope and lifecycle APIs. Indexes must support
consumer/subscription lookup and event matching. A later tenant-aware auth
adapter can populate the same principal fields without changing routing code.

## Validation

- two-consumer isolation test for list, claim, ack, pull, and replay;
- exact stream/finding-type/tag routing matrix;
- terminal-event routing test;
- authorization test with mismatched path, token, and subscription IDs;
- historical-vs-future subscription behavior test.

## Implementation review — 2026-08-18

The pure consumer service and transport-neutral API handler enforce
credential-derived tenant/consumer scope, exact stream authorization, cursor
binding, and acknowledgement idempotency. The consumer matcher delegates to
delivery-core, and the live PostgreSQL suite (3/3) covers tenant fan-out,
lease/retry/replay, and scope-bound cursor behavior. This ADR is implemented
for the M2 gate; an HTTP transport remains outside the current API boundary.
