# Durable delivery API contract

Status: **M2 handler acceptance green; transport-neutral by design; no HTTP server**

This document describes the consumer-facing surface. `apps/delivery-api`
currently implements transport-neutral handlers over the injected
`DeliveryConsumerService` ports and has focused credential-scope,
cross-tenant, cursor, and acknowledgement tests. The source and lockfile are
present. The current evidence is 5/5 tests, a clean install, and a TypeScript
build. The combined M2 gate also passes 3/3 live PostgreSQL conformance tests
for the durable adapter. This package is not an HTTP server; a transport
adapter remains future operational work.

## Authentication and scope

Every operation authenticates a consumer principal and derives the tenant and
consumer scope from that principal. A path or query `consumer_id` is not an
authorization mechanism. Subscription, attempt, acknowledgement, cursor, and
dead-letter IDs are checked against the authenticated principal before any
data is returned.

## Intended operations

The following routes are design targets, not current endpoints:

| Method/path | Purpose | Status |
|---|---|---|
| `POST /v1/consumers/{consumer_id}/subscriptions` | Create a scoped subscription | Handler foundation; transport/server not implemented |
| `GET /v1/consumers/{consumer_id}/subscriptions` | List the caller's subscriptions | Handler foundation; transport/server not implemented |
| `PATCH /v1/consumers/{consumer_id}/subscriptions/{subscription_id}` | Change filter/endpoint state | Handler foundation; transport/server not implemented |
| `GET /v1/consumers/{consumer_id}/events?subscription_id=&cursor=&limit=` | Pull a scoped page | Handler foundation; transport/server not implemented |
| `POST /v1/consumers/{consumer_id}/events/{event_id}:ack` | Record an idempotent receipt | Handler foundation; transport/server not implemented |
| `GET /v1/consumers/{consumer_id}/dead-letters` | Inspect scoped dead letters | Handler foundation; transport/server not implemented |
| `POST /v1/consumers/{consumer_id}/dead-letters/{event_id}:replay` | Request scoped, audited replay | Handler foundation; transport/server not implemented |

Route names may change only with an ADR and updated tests/docs. M1 producer
routes remain separate from this consumer surface.

## Pull response and cursor rules

The pull response returns protocol `0.1` event bodies plus delivery metadata
needed by the caller. The cursor is opaque and scoped to a subscription. The
server orders by a tenant-global monotonic delivery position; the historical
`stream_position` name may remain in storage, and `event_id` is a stable
tie-breaker where compatibility views need one. A caller must not construct or
transfer cursors between consumers. The repository/application boundary must
inject a runtime-backed signed cursor codec (normally `BoundCursorCodec`);
base64/JSON framing without signature, expiry, and scope verification is not a
valid implementation.

An acknowledgement is idempotent. Repeating an exact acknowledgement returns
the original receipt; conflicting acknowledgement parameters are rejected.

## Webhook contract

The worker sends the protocol event body as the exact signed wire JSON. The
body's required `attempt` field is authoritative and changes on every retry or
replay; the source `event_id`, payload, `occurred_at`, and payload hash remain
stable. The transport should also include event ID, delivery ID, protocol
version, timestamp, attempt, key ID, and signature metadata in documented
headers. The signature covers the pinned `timestamp.raw_body` input; trace
metadata is correlation data, not an undocumented protocol-body field.

The receiver must verify timestamp/replay window and signature, persist its
event-ID receipt before returning `2xx`, and treat duplicate event IDs as safe
replays. Non-2xx and timeout behavior maps to retry/dead-letter policy.

## Error classes

The eventual API should use stable error classes for:

- authentication or consumer scope failure;
- subscription not found or filter conflict;
- invalid/expired cursor;
- acknowledgement conflict;
- dead-letter/replay authorization failure;
- transient storage or delivery failure;
- security/signature rejection;
- bounded request/rate limits.

Responses must contain redacted diagnostics and a correlation/event ID, never
secrets, full evidence, or arbitrary source content.

## Compatibility and implementation gate

The M2 implementation gate is green for the transport-neutral application
boundary: auth, consumer isolation, idempotency, API documentation, clean
install/build, and the combined conformance command are covered. The current
handler tests are not evidence of a running HTTP service. The legacy
`apps/api/README.md` remains a separate reference app and is not the M2
delivery server.
