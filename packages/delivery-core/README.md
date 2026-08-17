# Agent Feed delivery core

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
- A delivery claim is a lease. A repository must compare the lease token on
  acknowledgement, retry, and dead-letter transitions; a stale worker cannot
  mutate a newer lease.
- A 2xx transport result is acknowledged. Network failures, 408, 425, 429,
  and 5xx responses are retryable. Other 4xx responses and unexpected 1xx/3xx
  responses are permanent failures.
- Backoff is pure and capped. The chosen `nextAttemptAt` is persisted by the
  repository, so a restart does not recalculate a different schedule.
- A worker crash after an outbound request and before acknowledgement can cause
  a duplicate. This is intentional at-least-once delivery; consumers must
  durably deduplicate by `eventId` before returning 2xx.
- A delivery event with `deliveryEligible: false` remains available for audit
  but is never matched into a consumer delivery job.
- `HmacCursorCodec` requires a canonicalizer supplied by the application. The
  canonicalizer should be the shared protocol-runtime implementation; this
  package does not define a second generic canonical-JSON implementation.
- Pull cursors are opaque HMAC tokens bound to tenant, consumer, subscription,
  selector version, position, and expiry. A cursor is not an acknowledgement.

## Adapter seam

The normal composition is:

```text
producer transaction
  -> append immutable outbox event + matching delivery rows
  -> durable queue wake-up (optional)
  -> DeliveryWorker claims lease
  -> injected signer creates signed body
  -> injected transport sends it
  -> repository compares lease token and acknowledges/retries/dead-letters
```

The worker never performs SQL or network I/O directly. A database adapter may
implement `DeliveryRepository` with `FOR UPDATE SKIP LOCKED` and compare-and-
swap updates. A queue adapter may enqueue only a delivery ID; a periodic sweep
must recover due rows if the queue drops a wake-up.
