# Milestone 2 durable-delivery acceptance matrix

This matrix is the gate for Agent Feed Milestone 2. It is deliberately
separate from the Milestone 0/1 protocol conformance matrix: these tests prove
durability and consumer isolation at the delivery boundary, not merely that a
wire payload validates.

The matrix is written before the delivery implementation so every branch can
use the same fixtures and failure semantics. The static architecture check is
safe to run now; it reports deferred M2 paths as `SKIP` and becomes strict when
those paths or the `0002` migration are added.

## Test layers and fixtures

| Layer | Purpose | Required environment |
| --- | --- | --- |
| Pure contract tests | Canonical event body, HMAC, key rotation, filter matching, retry schedule, cursor binding, metric classification | Node 22; no network or database |
| PostgreSQL integration | Outbox transaction, subscriptions, attempts, leases, acknowledgements, DLQ, replay, cursor state, tenant predicates | Disposable PostgreSQL 16 |
| Worker harness | Outage, duplicate send, timeout/429/5xx, crash-after-receipt, backoff, restart | Deterministic fake clock and in-process webhook harness |
| Race tests | Concurrent claims, expiry/reclaim, duplicate ack, concurrent cursor reads | PostgreSQL plus barriers; no wall-clock sleeps |
| Static architecture | Package boundaries, no direct SQL in delivery-core/worker/API, no Realtime queue dependency | `node scripts/check_delivery_architecture.mjs` |

Use `tests/delivery/fixtures.mjs` for the two-tenant/two-consumer fixture and
the deterministic webhook failure sequences. The fixture intentionally uses
the same stream name in both tenants; tests must not depend on globally unique
stream names to establish isolation.

## Acceptance rows

| ID | Area | Fixture/input | Public surface | Pass condition |
| --- | --- | --- | --- | --- |
| M2-01 | Transactional outbox atomicity | Finding/evidence batch; injected failure after accepted rows and after outbox insert | Ingress application service + PostgreSQL | Accepted rows and outbox events commit together. Any pre-commit failure leaves neither partial data nor an orphan outbox event. Idempotent retry creates one logical event. |
| M2-02 | Outage recovery | `failureSequence("unavailable")`; restart worker while events are pending | Queue worker + webhook harness | Committed events remain pending during outage, survive worker restart, and are eventually delivered after recovery. No committed event is lost. |
| M2-03 | Duplicate delivery | `failureSequence("crashAfterReceipt")` | Worker + consumer receipt store | The same `event_id` may be sent repeatedly, but a durable consumer receipt and side effect exist once. Acknowledgement is idempotent. |
| M2-04 | Tenant/subscription isolation | `twoTenantDeliveryFixture()` | Push, pull, acknowledge, replay, and list APIs | Consumer A cannot see, claim, acknowledge, replay, or infer Consumer B/Tenant B events. Filters are applied with tenant and subscription scope in the query. |
| M2-05 | Subscription filters | Same fixture plus nonmatching finding type/tag events | Subscription registration and enqueue path | Stream, finding type, and routing-tag filters are deterministic. Empty filters have documented match-all behavior. Terminal events follow the documented stream rule. |
| M2-06 | Signature/replay protection | Fixed clock; current/previous/unknown keys; ±300/±301 seconds; body/header mutation | Signed webhook verifier | Exact raw body and valid key verify. Stale, altered, wrong-key, unknown-key, and mismatched-body requests fail. Rotation overlap follows the 24-hour policy. |
| M2-07 | Lease/crash recovery | Two workers, claim barrier, expired lease | Claim/ack/retry repository | Claim is atomic. A crash makes work reclaimable after lease expiry. A stale worker cannot ack or mutate a new lease. Attempt numbers are monotonic. |
| M2-08 | Retry/backoff | Healthy, timeout, 408/429, 5xx, permanent 4xx outcomes | Retry scheduler + worker | Retryable failures use persisted exponential backoff and limits; permanent 4xx does not hot-loop; `Retry-After` is honored as documented; restart preserves next-attempt time. |
| M2-09 | Dead-letter/replay | Permanent failure until max attempts, then replay | DLQ and replay API | DLQ preserves immutable event ID, payload hash, reason, attempt history, and trace ID. Replay is idempotent and reuses the same logical event/payload; it does not reset history or create an unintended duplicate. |
| M2-10 | Pull cursor isolation | Two subscriptions, concurrent insertion, changed filter, tampered token | Pull endpoint/cursor store | Cursor is bound to tenant, consumer, subscription, and filter version. Wrong-scope/tampered/expired cursors fail. Pagination has no cross-scope reads or silent skips. |
| M2-11 | Trace IDs and metrics | One retry, duplicate send, ack, DLQ, and replay | Worker logs/metrics | Trace ID propagates ingress → outbox → every attempt → webhook/pull response. Queued, attempted, delivered, retried, acknowledged, DLQ, backlog, and latency metrics are distinct and duplicate acks do not double count. |
| M2-12 | Realtime is not queue | Realtime/Supabase unavailable; optional projection disabled | Worker + architecture scan | Durable delivery still works without Realtime. Worker imports no Realtime/Supabase client and does not use projection rows/channels as queue state. |

## Schema and boundary assertions

Once `packages/persistence-postgres/migrations/0002*.sql` exists, the static
check requires `consumer_subscriptions`, a `subscription_id`, per-subscription
attempt/acknowledgement state, and persisted lease/retry/dead-letter fields.
The old `outbox_events.delivered_at` column is not an acknowledgement receipt:
delivery state belongs to the consumer subscription/attempt tables.

The static check also enforces these package directions:

```text
protocol-runtime  ──> (protocol-only dependencies)
       ▲
       │
delivery-core      ──> protocol-runtime
       ▲
       │
worker/API         ──> delivery application service
```

`protocol-runtime` must not import `delivery-core`, workers, APIs, Realtime,
Supabase, the Rewards Optimizer, or the M1 prototype. `delivery-core` may use
the protocol runtime but must not contain PostgreSQL/SQL or perform network
delivery itself. Worker/API paths must not import a database driver or issue
SQL directly.

## Commands

The repository currently has no root M2 command, so run the static test
directly while implementation is in progress:

```sh
node scripts/check_delivery_architecture.mjs
node --test tests/delivery/*.test.mjs
```

The combined M2 CI job should expose equivalent commands once package scripts
are added:

```sh
npm run validate:foundation
npm run checksums:check
npm run types:check
npm run protocol:compatibility
npm run conformance:test
npm run m2:unit
npm run m2:integration
npm run m2:race
npm run m2:architecture
AGENT_FEED_DATABASE_URL=... npm run m2:postgres
```

The PostgreSQL job must fail rather than skip when its database URL is absent.
Use a clean PostgreSQL 16 service and namespace all fixture IDs. Persist SQL,
worker, and harness logs on failure.

## Race/flakiness controls

- Use a fake clock and explicit barriers; never assert with uncontrolled sleeps.
- Assert event sets and invariants, not incidental HTTP arrival order.
- Use unique tenant/consumer fixture IDs per test and clean/reset the database.
- Keep webhook tests in-process with explicit timeouts and scripted outcomes.
- Repeat claim/lease/cursor races at least 20 times in a dedicated CI job.
- Keep trace/metric assertions scoped to one test run; do not share global
  counters between parallel tests.
- Treat duplicate sends as allowed, but fail on loss, cross-tenant visibility,
  stale-lease acknowledgement, signature bypass, or payload mutation.

## Gate

M2 is **not accepted** until every row passes against a clean PostgreSQL
environment with no skipped durability, outage, isolation, signature, lease,
replay, cursor, or Realtime tests. At-least-once duplicate sends are allowed;
lost committed events, cross-tenant reads, stale/replayed signatures, stale
lease acknowledgements, non-deterministic replay payloads, and any dependency
on Realtime as queue state are hard failures.
