# PostgreSQL persistence boundary

`@agent-feed/persistence-postgres` owns the PostgreSQL adapter for Agent Feed
Milestones 1 and 2. It owns the `agent_feed` schema and keeps the database
separate from consumer/domain tables, HTTP handlers, and worker transport code.

The `PostgresAgentFeedPersistence` service provides:

- idempotent `beginRun`, with a canonical payload hash and conflict detection;
- transaction-locked, atomic `submitBatch`, including increasing sequences,
  evidence-reference resolution, and immutable accepted rows;
- terminal/idempotent `completeRun`, with completion-time, scope, and accepted
  count reconciliation;
- queryable runs (including completed zero-finding runs);
- persisted stream expectations and an overdue-run sweep;
- immutable terminal runs enforced by database triggers.

Milestone 2 adds an ordered migration loader (`0001_agent_feed.sql` followed by
`0002_durable_delivery.sql`), an immutable outbox, normalized versioned
selectors, tenant-global delivery positions, and a per-subscription queue. The
ingress methods append `run.started`, `finding.submitted`, and terminal run
events through the same transaction client as accepted rows. A quarantined
finding remains auditable but is never fanned out.

`PostgresDeliveryRepository` owns only durable state: `FOR UPDATE SKIP LOCKED`
leases, append-only attempt history, idempotent acknowledgements, retry/DLQ
transitions, expired-lease recovery, replay idempotency, and pull paging. It
does not resolve secrets, sign bodies, call webhooks, or import worker/API
code. `delivered_at` from the M1 placeholder is retained for compatibility and
is not a delivery source of truth; delivery identity is
`(tenant_id, subscription_id, event_id)`.

`PostgresDeliveryConsumerRepository` implements the
`@agent-feed/delivery-consumer` repository port for the durable API
composition. It owns subscription records and future-effective normalized
selector versions, pull-page position queries, bulk ACK command idempotency,
dead-letter listing, and replay commands. The consumer service remains the
boundary for authenticated scope, selector normalization, signed cursor
encoding/decoding, cursor TTL, and error translation; this adapter accepts
positions only and never constructs opaque cursors. Bulk ACKs are recorded in
`acknowledgement_commands`, while per-delivery acknowledgement rows remain
append-only receipts. Pull ACK transitions are allowed from queued/retry state;
webhook ACK transitions still require an in-flight lease.

Selector versions are future-effective. Registration captures the current
tenant-global delivery position; later versions deactivate the prior version
and only match events with a greater position. Pull requires an injected
`delivery-core` `CursorCodec`; this adapter has no base64, signing, or expiry
implementation. The repository applies an explicit configurable cursor TTL
(900 seconds by default) when it asks the codec to encode a page cursor, and
the codec enforces tamper, expiry, scope, and version checks.
The position is tenant-global even though the historical `stream_position`
column remains populated for M1 readers.

Hashing delegates to the `@agent-feed/protocol-runtime` file dependency so
canonical JSON and SHA-256 behavior is shared with signing/runtime consumers.

## Test

From this directory:

```sh
npm install
npm run build
npm test
```

`npm test` always runs structural/unit tests. Set
`AGENT_FEED_DATABASE_URL` to run the live PostgreSQL regression tests as well;
the live suite uses unique tenant/fixture IDs in the `agent_feed` schema and
covers migration idempotence, atomic lifecycle fan-out, selector filtering,
leases, acknowledgements, DLQ, and replay. Use a disposable test database when
running it repeatedly. The package does not start or stop a database server.

The combined M2 acceptance runs this package with a disposable PostgreSQL
database: **10/10 tests pass**, including the consumer-service composition and
the two repository/live persistence
cases that are skipped when no database URL is provided. All seven M2 package
and application installs/builds/tests are exercised by the repository workflow;
the workflow definition is present, but this README does not claim a hosted
GitHub Actions run.
