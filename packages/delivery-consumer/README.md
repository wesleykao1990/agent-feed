# Consumer delivery application service

Status: **implemented; combined durable-delivery acceptance is green.**

`@agent-feed/delivery-consumer` is the pure application layer for Agent Feed
Milestone 2 consumer operations. It has no SQL, PostgreSQL, HTTP, queue, or
Supabase dependency. A durable adapter implements the injected repository;
transport workers remain in the delivery-core boundary.

## Boundary

```text
authenticated consumer request
  → ConsumerAuthPort.getContext()
  → DeliveryConsumerService
  → DeliveryConsumerRepository / CursorCodec / PayloadHasher
```

Tenant and consumer identity are taken only from `ConsumerAuthContext`. They
are never accepted in create, update, pull, acknowledgement, or replay input.
The repository receives a `(tenantId, consumerId)` scope on every operation.
Cross-scope records are intentionally reported as `not_found`.

## Selector semantics

- `streamIds` is required and is an exact allowlist. Wildcards are unsupported.
- `findingTypes` is optional and ORed within the list.
- `routingTags` is optional and explicitly chooses `any` or `all` matching.
- `eventTypes` is optional and defaults to every pinned protocol event type.
- Stream, finding-type, and tag constraints are ANDed across dimensions.
- Finding-type and tag filters apply only to `finding.submitted`.
- Run lifecycle events match only by stream and event type, allowing a filtered
  consumer to receive terminal lifecycle signals deliberately.
- Pull delivery has no endpoint or signing key. Webhook delivery requires both
  a non-empty endpoint reference and a non-empty signing-key reference; key
  material remains outside this package.

The normalized selector shape and matching implementation are owned by
`packages/delivery-core` and imported here; this package only validates and
normalizes request input into that shared shape. Selectors are normalized
(including deterministic ordering) before hashing. Selector changes create a
new selector version and are marked `future`; the repository must apply them
only after its transaction boundary. A new subscription is future-only by
default: the repository captures the current tenant-global outbox position
atomically as `activationPosition`. Pull cursors use that same tenant-global
decimal position across all streams selected by a subscription; it is not a
per-stream offset.

## Pull and acknowledgement

The service delegates cursor encoding and decoding to `CursorCodec`. The codec
must bind a token to tenant, consumer, subscription, and selector version. The
service validates those claims and never parses an opaque token itself.

`nextCursor` is a page scan position. A client should persist it only after
the returned deliveries have been durably acknowledged. `ackCursor` represents
the highest contiguous acknowledgement position supplied by the repository.
This separation preserves at-least-once delivery after a client crash.

Acknowledgements are scoped by subscription delivery ID, not merely event ID.
The service sorts IDs before calling the injected `PayloadHasher`, so retries
with the same logical request have the same idempotency payload hash. A
different request under the same idempotency key must be rejected by the
repository as `idempotency_payload_conflict`.

Dead-letter replay is also subscription-scoped and idempotent. Replaying a
delivery must preserve the original event ID/payload while creating a new
delivery attempt or replay generation in the durable adapter.

## Adapter seam

The repository contracts use neutral camel-case records. An adapter can map
them to `packages/delivery-core` records without coupling this package to that
worker implementation:

| Consumer package | Delivery-core mapping |
| --- | --- |
| `SubscriptionRecord.id` | `ConsumerSubscription.subscriptionId` |
| `selectors.streamIds` | `ConsumerSubscription.streamIds` |
| `selectors.findingTypes` (`null` means any) | `ConsumerSubscription.findingTypes` |
| `selectors.routingTags` with `mode: any/all` | adapter-owned selector snapshot |
| `SubscriptionDeliveryRecord.deliveryId` | `DeliveryJob.deliveryId` |
| `DeliveryEventRecord.position` (tenant-global) | `DeliveryEvent.sequence` |
| `ReplayDeadLetterRecord` | `ReplayInput` plus adapter idempotency receipt |

The delivery-core normalized contract uses `null` for an unrestricted finding
type/tag dimension and requires non-empty exact stream/event-type arrays. The
adapter must preserve that contract; an empty stream selector must never
become an unrestricted subscription.

`PayloadHasher` is injected intentionally. Canonical JSON and hash ownership
belongs to the protocol-runtime package; this package does not duplicate it.
Likewise, `CursorCodec` is injected so the production HMAC/expiry implementation
can be shared without importing crypto or encoding policy here.

## Decisions, bugs, and learnings

- Decision: use per-subscription delivery IDs and acknowledgement state. A
  global `outbox_events.delivered_at` cannot isolate multiple consumers.
- Decision: treat selector changes as future-effective versions. Rewriting
  queued deliveries would make replay and audit behavior ambiguous.
- Decision: lifecycle events ignore finding filters but honor stream/event-type
  filters. This keeps terminal completion observable without broadening finding
  delivery.
- Decision: all scope checks fail closed and cross-scope reads return
  `not_found`, preventing resource-existence leaks.
- Decision: webhook configuration is all-or-nothing at this boundary; both
  endpoint and signing-key references are required, while pull subscriptions
  reject either field.
- Learning: cursor scan position and acknowledgement position must remain
  separate; advancing a client cursor before acknowledgement can lose events.
- Learning: the cursor/hash implementations belong to injected runtime seams,
  not a second copy in the consumer application layer.
The current evidence is 10/10 deterministic unit tests, a clean install, and a
clean TypeScript build. The combined M2 gate adds 3/3 live PostgreSQL tests for
transactional fan-out, lease/retry/replay, and signed cursor isolation. This
package remains transport-neutral; a deployable HTTP server is outside its
scope.

## Test

```sh
npm test
```
