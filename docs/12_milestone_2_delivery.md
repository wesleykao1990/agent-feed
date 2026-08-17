# Milestone 2 — Durable consumer delivery

Status: **implementation gate complete in this repository; operational follow-ups remain**

This document is the canonical design and status record for Agent Feed
Milestone 2. The current branch contains the protocol runtime, pure delivery
core, consumer service, PostgreSQL delivery repository/outbox, webhook adapter,
worker composition, transport-neutral API handlers, and explicit `0001` then
`0002` migration loading. The combined acceptance is green: architecture 4,
pure conformance 6, live PostgreSQL 3, protocol-runtime 5, delivery-core 11,
delivery-consumer 8, persistence 9, webhook adapter 7, worker 4, and API 3.
All seven M2 packages/applications have clean installs, builds, and tests. The
API remains transport-neutral without a deployable HTTP server; the worker has
no production process/CLI entrypoint; and observability exporter/deployment
remains future operational work. The repository workflow is configured to
install/build/test all seven and require live PostgreSQL, but no hosted GitHub
CI run is claimed.

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
          +--> packages/delivery-consumer --> apps/delivery-api
          +--> packages/persistence-postgres
          +--> apps/delivery-worker
```

### `packages/protocol-runtime/`

Owns shared, domain-neutral primitives only:

- canonical JSON serialization;
- HMAC signing and verification;
- replay-window and key-ID value objects;
- any protocol-runtime error types.

It must not import PostgreSQL, HTTP servers, the prototype, Supabase, or
consumer-domain code. This foundation exists and its tests/build pass.
Production persistence hashing and worker/webhook signing use this boundary;
the in-memory prototype retains historical helpers as a non-production
reference. That reference duplication is documented but is not an M2
implementation-gate blocker.

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
Rewards Optimizer terms. It has 18/18 unit tests and a clean TypeScript build;
the combined live PostgreSQL suite is also green (3/3). The consumer
application delegates matching to this package's normalized matcher, and the
multi-stream cursor contract is accepted using the tenant-global position.

### `packages/persistence-postgres/`

Owns the durable adapter. The additive
`migrations/0002_durable_delivery.sql` foundation and a
`PostgresDeliveryRepository` now exist, and the ingress store calls the
transaction-aware outbox writer for begin/batch/complete paths. The loader
explicitly applies `0001` then `0002` when called without an explicit SQL
string; arbitrary directory discovery/gap checking is future operational work.
The live repository/transaction acceptance is green (3/3), and the M1
migration remains historical. The adapter owns SQL for:

- immutable outbox rows;
- consumer-scoped subscriptions;
- per-event/per-subscription attempts and leases;
- acknowledgements, dead letters, and cursor state.

It must not own webhook/network behavior. Existing ingress methods need a
narrow transaction seam so the outbox writer uses the same transaction client
as accepted M1 records.

### `packages/webhook-adapter/`

Owns outbound network safety only: endpoint/DNS validation, fixed-address HTTP,
timeouts, body bounds, redirect denial, safe response hashes, and HTTP retry
classification. Its eight focused tests and TypeScript build pass. It does not
own subscriptions, SQL, queue claims, signing keys, or process lifecycle; the
worker process must inject it through the delivery-core transport port.

### `apps/delivery-worker/`

Owns process lifecycle, queue claiming, lease renewal, webhook transport,
signing-key selection, retry scheduling, graceful shutdown, and metrics
export. It consumes `delivery-core` ports and does not issue SQL directly.
`apps/delivery-worker` now provides the composition root, protocol signer,
webhook retry bridge, recovery-before-claim cycle, and abortable loop. Its 6/6
tests, clean install, and TypeScript build pass. It has no production
deployment/CLI entrypoint; the live PostgreSQL acceptance covers repository
lease/retry/replay behavior, while an external endpoint deployment remains
future operational work. The pure worker remains in
`packages/delivery-core/src/worker.ts`.

### `apps/delivery-api/`

Owns the application-facing delivery control surface when implemented:

- subscription creation/update/listing;
- pull reads and cursor validation;
- acknowledgement;
- authenticated dead-letter inspection and replay.

Handlers call an application service. They must not query Agent Feed tables
directly and must enforce the consumer/tenant scope on every operation. The
pure service exists in `packages/delivery-consumer/src/service.ts`, with 10/10
unit tests and a clean build. `apps/delivery-api` adds transport-neutral
handlers with focused scope/cursor/idempotency tests; its 5/5 tests, clean
install, and build pass. It intentionally has no HTTP server. The persistence
repository remains an injected adapter rather than direct API SQL; the live
PostgreSQL gate covers the durable adapter separately. The legacy `apps/api`
remains a separate M1 reference surface.

## Data and transaction rules

The existing `outbox_events.delivered_at` column is global and cannot represent
delivery to multiple consumers. It must not be used as the delivery source of
truth. Delivery state is keyed by `(subscription_id, event_id)`. The current
repository/migration foundation now writes per-subscription rows in the same
transactional seam as the source event; the combined live PostgreSQL proof is
green.

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

## Foundation regression fixes awaiting combined acceptance

The current implementation pass also addresses six integration findings that
must remain visible in the acceptance record:

- pull cursors use the runtime-owned signed `BoundCursorCodec`; unsigned
  base64/JSON cursors are not acceptable;
- multi-stream pull uses one tenant-global `delivery_position`, while the
  historical per-stream position remains compatibility data only;
- begin idempotency uniqueness is tenant-scoped;
- finding event payloads include full submitted-evidence objects, not only
  evidence IDs;
- an outbox retry with changed immutable content raises an explicit drift
  conflict instead of being silently ignored; and
- production cross-package imports use public package exports rather than
  `/src/*` subpaths.

These fixes have structural/unit and live PostgreSQL evidence in the current
checkout. See `docs/m2/BUGS.md` entries M2-018 through M2-022 and the
corresponding learning entries; they are resolved for the M2 implementation
gate, with only documented operational follow-ups remaining.

## Event and protocol compatibility

The wire body remains the existing protocol `0.1` `DeliveryEvent`. It is
validated against `packages/schema/contracts/delivery-event.schema.json`.
The required `attempt` field is part of the signed event body. A retry/replay
therefore emits a newly encoded raw body and signature with the incremented
attempt; `event_id`, `payload`, `occurred_at`, and payload hash remain stable.
Timestamp, key ID, delivery ID, and internal trace lineage are additionally
carried in delivery state and transport headers without adding new body
fields.

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

Replay keeps the immutable event ID, payload, occurred time, and payload hash,
records an operator/replay reason, and creates a new monotonically numbered
attempt. Because `attempt` is required in the signed protocol body, replay and
retry produce a new raw body/signature for that attempt; the immutable source
event and prior attempt records are not rewritten or erased. A replay is safe
only after consumer scope, signature configuration, and payload sensitivity
are rechecked.

An acknowledgement is idempotent. A webhook `2xx` means the receiver accepted
the signed event according to the external contract; Agent Feed cannot prove
the receiver's internal transaction, so the receiver must persist its event ID
before returning success. Pull consumers explicitly acknowledge after their
own durable receipt.

## Pull cursor and trace rules

Pull cursors are opaque to callers and represent a tenant-global monotonic
delivery position. The schema may retain the historical `stream_position`
column name for protocol/storage compatibility, but the allocator must not
reset by stream. A single global order is required when a selector covers more
than one stream; timestamp/event ID may remain a secondary deterministic
ordering aid. Ordering must include a unique tie-breaker so events with the
same timestamp are not skipped or repeated indefinitely.

The migration now carries both a compatibility `stream_position` and a
tenant-global `delivery_position` allocated by `tenant_event_counters`. The
repository orders/activates by the global position. The combined live
PostgreSQL cursor suite passes, closing the M2 decision: the global position
supplies the future-only activation boundary captured when a subscription is
created or its selector changes, preventing a multi-stream subscription from
mixing historical rows into a later page.

Trace lineage must survive ingress, outbox, attempt, transport, acknowledgement,
retry, and replay. Until a protocol-level trace field is approved, trace data
is internal delivery metadata and metrics; the signed event ID remains the
authoritative wire lineage.

## Implementation status and gates

The following table records the current implementation-gate evidence. It does
not claim that deferred production deployment surfaces already exist:

| Capability | Status | Evidence required before marking complete |
|---|---|---|
| Protocol runtime and exact wire signing | Accepted | 5 tests; clean install/build; production runtime paths use the public boundary |
| Pure delivery worker/retry/lease ports | Accepted | 18 tests; clean install/build; live repository behavior covered by 3 PostgreSQL tests |
| Consumer service/selectors/cursor contract | Accepted | 10 tests; clean install/build; live scope/cursor paths pass |
| Additive M2 migration shape | Accepted for the explicit pair | Persistence suite 10/10 with PostgreSQL; loader remains explicit `0001` then `0002` |
| Atomic outbox | Accepted | Live PostgreSQL transactional outbox/fan-out/immutability coverage passes |
| Durable subscriptions/delivery repository | Accepted | Live PostgreSQL lease/retry/ack/DLQ/replay/cursor coverage passes |
| Queue worker process/webhook transport | Accepted composition boundary | Worker 6 tests and webhook 8 tests pass; production process/endpoint deployment is future operational work |
| Pull API/ack/replay handlers | Accepted transport-neutral boundary | API 5 tests; clean install/build; no deployable HTTP server by design |
| Metrics/trace lineage | Accepted contract foundation | Pure metrics/trace behavior passes; production exporter/deployment remains future operational work |
| Root clean installs/builds/tests | Workflow configured | Repository workflow covers all seven M2 packages/applications and requires live PostgreSQL; no hosted GitHub run is claimed |
| Operations/docs | Reconciled for implementation gate | Evidence, ADRs, runbooks, bug log, learning log, and modularity audit updated |

The M2 implementation gate is complete in this repository when the combined
acceptance command passes with PostgreSQL. Hosted GitHub CI execution and final
release packaging/checksum refresh remain separate handoff steps.

## Implementation gate decision — 2026-08-18

**Decision: GO for the M2 implementation gate in this repository.**

The combined acceptance is green:

- architecture: **4**;
- pure conformance: **6**;
- live PostgreSQL conformance: **3**;
- protocol-runtime: **5**;
- delivery-core: **11**;
- delivery-consumer: **8**;
- persistence-postgres: **9**;
- webhook-adapter: **7**;
- delivery-worker: **4**;
- delivery-api: **3**.

All seven M2 packages/applications have clean installs, builds, and tests. The
repository workflow definition installs/builds/tests all seven and requires a
live PostgreSQL URL. No hosted GitHub Actions run is claimed by this document.

The following are accepted nonblocking scope caveats, not failed M2 evidence:

- `apps/delivery-api` is transport-neutral and has no deployable HTTP server;
- `apps/delivery-worker` has no production process/CLI entrypoint or hosted
  external webhook deployment;
- observability exporter/deployment remains future operational work;
- migration loading is explicitly `0001_agent_feed.sql` followed by
  `0002_durable_delivery.sql`, rather than arbitrary directory discovery;
- the in-memory prototype retains historical protocol helpers as a reference;
- release packaging/checksum refresh and a hosted GitHub CI run remain handoff
  tasks after the shared worktree is finalized.

No skipped live PostgreSQL test was counted in this decision. The detailed
resolution evidence is appended in `docs/m2/BUGS.md` and
`docs/m2/LEARNINGS.md`.

## Accepted scope notes

The following are intentional boundaries rather than contradictory status
claims:

- `apps/api/README.md` remains a separate M1 reference app; the M2 API lives
  in `apps/delivery-api` and is transport-neutral without an HTTP server.
- `prototype/src/store.ts` remains an in-memory reference and is not the durable
  outbox implementation.
- `packages/delivery-consumer/src/selectors.ts` delegates normalized matching
  to delivery-core; the combined selector and scope tests are green.
- The schema retains compatibility `stream_position`, but only tenant-global
  `delivery_position` backs multi-stream cursors; the live cursor suite passes.
- Production imports use package names and public exports; the source-subpath
  regression is retained as a clean-install/static-audit guard.
- The metric sink and bounded labels satisfy the implementation gate; a
  production exporter and deployment remain future operational work.
- The loader intentionally applies the explicit `0001`/`0002` pair; arbitrary
  migration-directory discovery is not part of this M2 implementation gate.
- The repository workflow definition covers all seven M2 packages/apps and
  requires live PostgreSQL, but no hosted GitHub CI result is claimed here.
