# Milestone 2 — Durable consumer delivery

Status: **in progress — design baseline only**

This document is the canonical design for Agent Feed Milestone 2. It does not
claim that any M2 worker, delivery API, migration, or durable queue is already
implemented. A design item becomes complete only when its implementation,
tests, operational documentation, and validation report agree.

## Objective

Deliver accepted Agent Feed events to isolated consumers without losing an
event during consumer downtime. Delivery is at-least-once across the HTTP
boundary. Consumers must record an idempotency receipt keyed by the immutable
event ID before acknowledging a delivery.

The M2 boundary is:

```text
M1 ingress transaction
  -> immutable outbox event
  -> subscription match
  -> leased delivery attempt
  -> signed webhook or pull cursor
  -> consumer acknowledgement/receipt
  -> delivered, retried, or dead-lettered state
```

Realtime remains an optional projection for an administrative screen. It is
not a queue, an acknowledgement mechanism, or a recovery source.

## Scope

M2 delivers:

- an outbox write in the same PostgreSQL transaction as accepted findings,
  evidence, and terminal run state;
- durable per-consumer subscriptions filtered by stream, finding type, and
  routing tag;
- a queue-backed worker using database leases and `FOR UPDATE SKIP LOCKED` or
  an equivalent adapter contract;
- signed webhook attempts using the existing protocol `0.1` event body;
- an optional pull cursor with stable, opaque ordering;
- bounded exponential retry, attempt history, dead-letter state, and replay;
- idempotent acknowledgements;
- event/attempt lineage and delivery metrics.

M2 does not deliver:

- Rewards Optimizer domain rules or canonical evidence;
- a Python SDK, polished MCP deployment, or the broad adapter catalogue;
- a browser-facing administrative dashboard;
- a production Supabase deployment requirement;
- a new protocol version without an explicit compatibility decision.

## Module ownership and dependency direction

The implementation should keep dependency direction one-way:

```text
packages/schema/contracts
          |
          v
packages/protocol-runtime
          |
          v
packages/delivery-core
          |
          +--> packages/persistence-postgres
          +--> apps/delivery-worker
          +--> apps/api/src/delivery
```

### `packages/protocol-runtime/`

Owns shared, domain-neutral primitives only:

- canonical JSON serialization;
- HMAC signing and verification;
- replay-window and key-ID value objects;
- any protocol-runtime error types.

It must not import PostgreSQL, HTTP servers, the prototype, Supabase, or
consumer-domain code. The existing implementations in
`prototype/src/wire.ts`, `prototype/src/security.ts`, and
`packages/persistence-postgres/src/hash.ts` are known duplication and should
delegate to this one implementation when the code pass begins.

### `packages/delivery-core/`

Owns pure delivery behavior and ports:

- `types.ts`: subscriptions, delivery envelopes, attempts, leases,
  acknowledgements, dead letters, cursors, and trace metadata;
- `ports.ts`: outbox, subscription, lease, acknowledgement, cursor, clock,
  signing-key, webhook, and metrics interfaces;
- `routing.ts`: deterministic stream/finding-type/routing-tag matching;
- `backoff.ts`: bounded retry schedule with an injectable clock/jitter policy;
- `service.ts`: state transitions over the ports.

The package must not contain SQL, network calls, process-global timers, or
Rewards Optimizer terms. Unit tests use fake ports and a fake clock.

### `packages/persistence-postgres/`

Owns the durable adapter. M2 should add an additive
`migrations/0002_durable_delivery.sql` and a dedicated delivery repository;
the M1 migration remains historical. The adapter owns SQL for:

- immutable outbox rows;
- consumer-scoped subscriptions;
- per-event/per-subscription attempts and leases;
- acknowledgements, dead letters, and cursor state.

It must not own webhook/network behavior. Existing ingress methods need a
narrow transaction seam so the outbox writer uses the same transaction client
as accepted M1 records.

### `apps/delivery-worker/`

Owns process lifecycle, queue claiming, lease renewal, webhook transport,
signing-key selection, retry scheduling, graceful shutdown, and metrics
export. It consumes `delivery-core` ports and does not issue SQL directly.

### `apps/api/src/delivery/`

Owns the application-facing delivery control surface when implemented:

- subscription creation/update/listing;
- pull reads and cursor validation;
- acknowledgement;
- authenticated dead-letter inspection and replay.

Handlers call an application service. They must not query Agent Feed tables
directly and must enforce the consumer/tenant scope on every operation.

## Data and transaction rules

The existing `outbox_events.delivered_at` column is global and cannot represent
delivery to multiple consumers. It must not be used as the delivery source of
truth. Delivery state is keyed by `(subscription_id, event_id)`.

An accepted batch transaction must either commit all of the following or none:

1. the batch;
2. submitted evidence;
3. findings and finding/evidence references;
4. one immutable finding event per accepted finding;
5. any terminal event emitted by the same transaction.

An exact ingress retry returns the original result and creates no additional
outbox row. A payload change under the same idempotency key remains a conflict.
A failed transaction leaves no accepted rows and no outbox rows.

Outbox payloads preserve the untrusted finding/evidence semantics. Delivery
does not verify a finding, promote evidence, or change a consumer-domain fact.

## Event and protocol compatibility

The wire body remains the existing protocol `0.1` `DeliveryEvent`. It is
validated against `packages/schema/contracts/delivery-event.schema.json`.
Signature timestamp, key ID, attempt metadata, and internal trace lineage may
be stored in delivery state and transport headers without changing the event
body.

The current schema has `additionalProperties: false`; adding a required or
body-level delivery field requires an explicit protocol compatibility decision,
regenerated TypeScript/Python types, baseline review, examples, conformance
tests, and checksums. M2 must not silently alter protocol `0.1`.

The existing prototype event helper uses camelCase object fields while the
wire schema is snake_case. This is recorded in `docs/m2/BUGS.md`; M2 signing
and transport code must use one canonical wire conversion before signing.

## Subscription and isolation semantics

Each subscription belongs to one authenticated consumer and tenant scope.
Matching is deterministic:

- `stream_id` is exact unless a deliberately documented wildcard policy is
  selected;
- a finding-type filter matches only finding events;
- routing tags match according to an explicit all/any policy recorded in the
  subscription contract;
- terminal events route by stream and do not invent a finding type.

Subscription changes must document whether they affect only future outbox
events or can read historical events through a pull cursor. A new subscription
must never gain another consumer's attempts or acknowledgements by changing a
URL parameter or cursor.

## Queue, retry, acknowledgement, and replay

Workers claim pending attempts with a lease. A crashed worker's expired lease
becomes claimable again. Claiming must be safe for concurrent workers.

The initial retry function should be deterministic and bounded, for example:

```text
delay(attempt) = min(max_delay, base_delay * 2^(attempt - 1))
```

Any jitter must be injectable and testable. After the configured attempt limit,
the attempt is moved to a dead-letter state with the last error and trace
lineage preserved.

Replay keeps the immutable event ID, records an operator/replay reason, and
creates a new monotonically numbered attempt. It must not mutate the original
event body or erase prior failures. A replay is safe only after consumer scope,
signature configuration, and payload sensitivity are rechecked.

An acknowledgement is idempotent. A webhook `2xx` means the receiver accepted
the signed event according to the external contract; Agent Feed cannot prove
the receiver's internal transaction, so the receiver must persist its event ID
before returning success. Pull consumers explicitly acknowledge after their
own durable receipt.

## Pull cursor and trace rules

Pull cursors are opaque to callers and represent a stable tuple such as
`(created_at, event_id)`. Ordering must include a unique tie-breaker so events
with the same timestamp are not skipped or repeated indefinitely.

Trace lineage must survive ingress, outbox, attempt, transport, acknowledgement,
retry, and replay. Until a protocol-level trace field is approved, trace data
is internal delivery metadata and metrics; the signed event ID remains the
authoritative wire lineage.

## Implementation status and gates

At the time this design was written, M2 code and migrations were not yet
implemented. The following table is intentionally not a completion claim:

| Capability | Status | Evidence required before marking complete |
|---|---|---|
| Atomic outbox | Not implemented | PostgreSQL rollback/idempotency tests |
| Subscriptions/isolation | Design only | consumer-scoped live tests |
| Queue worker/leases | Not implemented | concurrent-worker and lease-expiry tests |
| Signed webhook | Prototype signing only | end-to-end fake receiver tests |
| Pull cursor | Design only | same-timestamp pagination tests |
| Retry/dead letter/replay | Design only | deterministic state-machine tests |
| Metrics/trace lineage | Design only | emitted metric/trace assertions |
| Operations/docs | This design pass | runbook, API docs, ADRs, logs, CI parity |

M2 is complete only when the implementation, tests, CI, validation report,
manifest, changelog, and checksum file are updated together.

## Contradictions requiring reconciliation

The existing repository contains intentional or historical reference claims
that must not be mistaken for completed M2 behavior:

- `docs/04_storage_and_delivery.md` describes the target atomic outbox but
  explicitly defers it; the code pass must update its status after delivery
  exists.
- `apps/api/README.md` lists consumer delivery endpoints although the app is
  currently README-only; this documentation pass treats those endpoints as
  unbuilt until executable handlers exist.
- `packages/persistence-postgres/README.md` says the outbox is reserved and
  not written; that remains true until the M2 migration and transaction seam
  land.
- `prototype/src/store.ts` stores in-memory events, not durable outbox rows.
- The prototype's camelCase event object and the snake_case wire schema need a
  single conversion boundary before signing.
- `migrateAgentFeed` currently loads only `0001_agent_feed.sql`; a migration
  directory loader is required before `0002` can be operational.

These contradictions are tracked in `docs/m2/BUGS.md` and must be resolved or
explicitly retained as historical reference before the M2 gate is signed.
