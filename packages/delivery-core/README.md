# Agent Feed delivery core

Status: **implemented; local core acceptance is green.** Durable adapter
acceptance remains an integration/repository gate outside this package.

This package contains the storage- and transport-independent Milestone 2
delivery domain. It owns the delivery state machine, subscription matching,
retry classification/backoff, pull-cursor binding, and bounded test metrics.

It deliberately does **not** import PostgreSQL, `fetch`, an HTTP client,
Supabase, Realtime, the prototype, or Rewards Optimizer code. A persistence
adapter supplies an atomic outbox/delivery repository; a queue is only a wake-up
hint and the repository remains the durable source of truth.

## Semantics

- Outbox event identity is immutable. `eventId` and `payloadHash` do not change
  on retries or replay.
- A normalized selector has a required exact stream allowlist, optional
  finding-type OR values, optional routing-tag `any`/`all` semantics, and an
  explicit list of protocol event types. Empty stream selectors are invalid;
  they are never treated as wildcards.
- Subscription selector versions and activation positions are future-only.
  Existing queued deliveries are not rewritten when a selector changes.
- The protocol `0.1` delivery body requires `attempt`. The signed body changes
  when the attempt increments; the source event ID, payload, occurred time, and
  payload hash do not.
- A delivery claim is a lease. A repository must compare the lease token on
  acknowledgement, retry, and dead-letter transitions; a stale worker cannot
  mutate a newer lease.
- Before signing or network I/O, the worker cross-checks the claimed event,
  job, and subscription identity/scope. It also checks signed metadata and
  required transport headers, sends `signed.rawBody` byte-for-byte, rejects
  CRLF/transport-controlled header overrides, and leaves protocol-body
  decoding to the runtime boundary.
- A 2xx transport result is acknowledged. Network failures, 408, 425, 429,
  and 5xx responses are retryable. Other 4xx responses and unexpected 1xx/3xx
  responses are permanent failures.
- Backoff is pure and capped. The chosen `nextAttemptAt` is persisted by the
  repository, so a restart does not recalculate a different schedule. The core
  retry policy default is five total attempts; persistence adapters must use the
  same default when materializing delivery rows.
- A worker crash after an outbound request and before acknowledgement can cause
  a duplicate. This is intentional at-least-once delivery; consumers must
  durably deduplicate by `eventId` before returning 2xx.
- A delivery event with `deliveryEligible: false` remains available for audit
  but is never matched into a consumer delivery job.
- Persisted signer and transport failures use bounded stable codes and generic
  messages; raw exception text never crosses the repository error boundary.
- `BoundCursorCodec` requires canonicalizer and signer ports supplied by the
  application. The canonicalizer/HMAC implementation should come from the
  shared protocol-runtime package; this package does not define a second
  canonical-JSON or HMAC implementation.
- Pull cursors are opaque HMAC tokens bound to tenant, consumer, subscription,
  selector version, position, and expiry. A cursor is not an acknowledgement.

## Adapter seam

The normal composition is:

```text
producer transaction
  -> append immutable outbox event (adapter snapshots subscriptions in-tx)
  -> durable queue wake-up (optional)
  -> DeliveryWorker claims lease
  -> injected signer/runtime creates signed attempt body
  -> injected transport sends it
  -> repository compares lease token and acknowledges/retries/dead-letters
```

The worker never performs SQL or network I/O directly. A database adapter may
implement `DeliveryRepository` with `FOR UPDATE SKIP LOCKED` and compare-and-
swap updates. A queue adapter may enqueue only a delivery ID; a periodic sweep
must recover due rows if the queue drops a wake-up. Metric labels are bounded
protocol dimensions such as event type; tenant, consumer, subscription, and
source IDs are deliberately excluded.

`appendOutboxEvent` accepts only the immutable source event. A durable adapter
must match active subscription versions and create delivery rows in the same
transaction; it must not rely on a subscription array supplied by an ingress
caller.

Pull adapters receive and return opaque cursor strings through `PullInput` and
`PullPage`. They must inject `BoundCursorCodec` (or another implementation of
the `CursorCodec` port) at the adapter/application boundary for decoding,
scope/expiry validation, and encoding. Core provides token framing only through
the injected codec: `BoundCursorCodec` owns base64url framing while delegating
canonicalization and signing to runtime ports. Adapters must not add unsigned
JSON/base64 cursor helpers.
The cursor payload's single decimal `position` is a tenant-global order, so it
works for selectors spanning multiple streams.

The in-memory metrics sink bounds both series cardinality and retained latency
samples. Its `maxObservationSamplesPerSeries` option defaults to 1,000 and
retains the newest samples; production exporters must enforce their own
allowlisted metric and label policy.

## Consumer contract mapping

`ConsumerSubscription.selectors` uses the same normalized shape as the
consumer application package. A subscription is matched only when it is
active, tenant-scoped, future of `activationPosition`, and the event is
delivery-eligible. Lifecycle events honor stream and event-type filters while
finding-type/tag filters apply only to `finding.submitted`.

## Current evidence and operational scope

The package has a deterministic unit-test suite, a clean install, and a clean TypeScript
build. Live PostgreSQL repository acceptance belongs to the persistence and
combined integration gates and must not be inferred from this package's unit
result. The package remains pure: the deployable worker process/CLI and HTTP
server are intentionally outside this boundary, and production observability
export remains future operational work. The normalized selector contract is
structurally identical to the consumer package: exact stream IDs, event-type
allowlists, finding-type OR, routing-tag any/all, and future-only activation
positions. The consumer service remains the owner of request validation and
authorization; this package only matches already-normalized snapshots.
