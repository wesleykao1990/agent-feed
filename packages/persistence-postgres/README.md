# PostgreSQL persistence boundary

`@agent-feed/persistence-postgres` owns the PostgreSQL adapter for Agent Feed
durable lifecycle and additive sidecars. It owns the `agent_feed` schema and keeps the database
separate from consumer/domain tables, HTTP handlers, and worker transport code.

The `PostgresAgentFeedPersistence` service provides:

- idempotent `beginRun`, with a canonical payload hash and conflict detection;
- producer-visible wire run IDs that remain arbitrary protocol strings while
  internal UUID primary/foreign keys stay unchanged;
- transaction-locked, atomic `submitBatch`, including increasing sequences,
  evidence-reference resolution, and immutable accepted rows;
- terminal/idempotent `completeRun`, with completion-time, scope, and accepted
  count reconciliation;
- queryable runs (including completed zero-finding runs);
- persisted stream expectations and an overdue-run sweep;
- immutable terminal runs enforced by database triggers.

Milestone 2 adds an ordered migration loader (`0001_agent_feed.sql` followed by
`0002_durable_delivery.sql` and `0003_wire_run_id.sql`); Milestone 7 appends
`0004_occurrence_ledger.sql`, `0005_job_proof.sql`, and
`0006_job_registry.sql`.
The loader preserves an immutable outbox, normalized versioned
selectors, tenant-global delivery positions, and a per-subscription queue. The
ingress methods append `run.started`, `finding.submitted`, and terminal run
events through the same transaction client as accepted rows. A quarantined
finding remains auditable but is never fanned out.

Milestone 7 adds the additive `0004_occurrence_ledger.sql` sidecar. Schedule
expectation versions carry an immutable
`stream_id`; expected occurrences and run links are tenant-scoped and
append-only; occurrence liveness joins the current run status, so a running,
failed, cancelled, partial, or completed-zero run remains distinct from an
absent invocation. `PostgresOccurrenceRepository` accepts the public wire run
ID and resolves it through the tenant-scoped internal UUID. Only scheduled
triggers may match normal expectations; legacy triggers are restricted to
legacy expectations, and explicit/windowed matching rejects missing or
ambiguous candidates. `@agent-feed/occurrence-core` is the sole repository
validator/calculator: `materializeScheduleOccurrences` bridges persisted
versions to the core expectation ID/version and stores only its canonical UTC
nominal keys and grace windows. Legacy `stream_expectations` migrate only a version-1
baseline; they do not fabricate historical occurrences or links. If old stream
activity cannot be attributed to tenant `default`, migration records a
deterministic quarantine row instead.

Trigger provenance is a separate immutable `run_trigger_contexts` receipt.
Schedulers or trusted adapters call `recordTrustedRunTriggerContext` before a
link; protocol runs without a context, or contexts for manual/test/retry/
replay/backfill/event/unknown triggers, cannot satisfy an expectation. Link
inputs never choose their trigger kind, and database triggers repeat the
tenant/version/stream/context/window checks for direct SQL callers. The legacy
terminal liveness trigger remains only for compatibility; M7 occurrence reads
do not consult its mutable state.

Milestone 8 adds the additive `0005_job_proof.sql` sidecar through
`PostgresAssessmentRepository`. It stores immutable validation policy versions,
trusted assessor registration versions, run assessment receipts, declared
budget rows, usage rows, and bounded artifact identity/provenance references.
The repository accepts only an exact trusted assessor-version context as its
authority boundary; assessment submissions cannot provide assessor identity,
type, independence, or technical run status. Authority snapshots are derived
from the registered row, and `producer_self_check` is always persisted as
`self`. Technical completion is read by joining the persisted run and never
changes a quality/security/compliance receipt.

`@agent-feed/assessment-core` validates and canonically hashes policy and
assessment values before the repository transaction. PostgreSQL repeats tenant,
authority, policy-kind, policy-budget, usage-state, artifact-hash, and
append-only checks for direct SQL callers. Usage values are nullable for
`unknown`/`not_applicable`; observed values are non-negative and require
non-unknown provenance. Artifact rows contain no blob/content/base64,
credentials, or signed URL material. Reassessment uses a new idempotency key,
must reference the same tenant/run/policy version, and appends a new receipt.

Policy registration and trusted-assessor registration are operator/composition
root methods only. They are deliberately not exposed through producer REST or
MCP paths; a production deployment must provide a dedicated assessor
composition root and role before making these methods reachable.

Milestone 9 adds `0006_job_registry.sql` and
`PostgresJobRegistryRepository`. Logical job definitions, provider capability
profiles, and deployment bindings are separate immutable tenant-scoped version
streams. `@agent-feed/job-registry-core` normalizes and hashes their canonical
documents and evaluates exact capability pins. PostgreSQL independently checks
the hashes and projected columns, capability/profile structure and versions,
provider topology, validation-policy reference, declared budgets, controlled
off-switch reference, and sealed independently passed shadow assessments.
Moving a job between providers appends a deployment-binding version while
preserving the exact logical definition ID.

Registry methods are trusted operator composition capabilities, not producer
REST or MCP tools. An `active` row is an auditable preflight receipt; the
repository never calls a scheduler/provider activation API. Instruction bodies,
credentials, signed URLs, inline/base64 content, unsafe numbers, and unbounded
metadata are rejected by both core and database validation.

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

`getRunForTenant` and `listRunsForTenant` are the authenticated read boundary;
the legacy unscoped `getRun`/`listRuns` methods remain for internal compatibility
and must not be exposed by producer HTTP handlers. Delivery event reads return
the wire run ID while `outbox_events.run_id` remains the internal UUID FK.

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
database: **11/11 tests pass**, including the producer wire-ID/lifecycle and consumer-service composition and
the two repository/live persistence
cases that are skipped when no database URL is provided. All seven M2 package
and application installs/builds/tests are exercised by the repository workflow;
GitHub Actions CI run #5 passed on draft PR #2 for commit `ad4ea3a`.
