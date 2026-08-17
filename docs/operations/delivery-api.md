# Durable delivery API contract

Status: **in progress — contract/design only; endpoints are not implemented**

This document describes the intended consumer-facing surface. It must not be
used as evidence that the current README-only API app can serve these routes.

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
| `POST /v1/consumers/{consumer_id}/subscriptions` | Create a scoped subscription | Not implemented |
| `GET /v1/consumers/{consumer_id}/subscriptions` | List the caller's subscriptions | Not implemented |
| `PATCH /v1/consumers/{consumer_id}/subscriptions/{subscription_id}` | Change filter/endpoint state | Not implemented |
| `GET /v1/consumers/{consumer_id}/events?subscription_id=&cursor=&limit=` | Pull a scoped page | Not implemented |
| `POST /v1/consumers/{consumer_id}/events/{event_id}:ack` | Record an idempotent receipt | Not implemented |
| `GET /v1/consumers/{consumer_id}/dead-letters` | Inspect scoped dead letters | Not implemented |
| `POST /v1/consumers/{consumer_id}/dead-letters/{event_id}:replay` | Request scoped, audited replay | Not implemented |

Route names may change only with an ADR and updated tests/docs. M1 producer
routes remain separate from this consumer surface.

## Pull response and cursor rules

The pull response returns protocol `0.1` event bodies plus delivery metadata
needed by the caller. The cursor is opaque and scoped to a subscription. The
server orders by `(created_at,event_id)` and uses `event_id` as a unique
tie-breaker. A caller must not construct or transfer cursors between consumers.

An acknowledgement is idempotent. Repeating an exact acknowledgement returns
the original receipt; conflicting acknowledgement parameters are rejected.

## Webhook contract

The worker sends the protocol event body as the exact signed wire JSON. The
transport should include event ID, protocol version, timestamp, attempt, key ID,
and signature metadata in documented headers. The signature covers the pinned
`timestamp.raw_body` input; trace metadata is correlation data, not an
undocumented protocol-body field.

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

No M2 route is considered implemented until an executable handler, auth test,
consumer-isolation test, idempotency test, API documentation, CI command, and
validation-report entry exist. The current `apps/api/README.md` is a reference
only and is intentionally not treated as implementation evidence.
