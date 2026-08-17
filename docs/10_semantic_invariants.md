# Agent Feed semantic invariants

JSON Schema defines portable shape. The implementation must also enforce:

- `running` runs have no completion time or actual scope; terminal runs have both;
- completion time is not earlier than start time;
- `sources_succeeded <= sources_attempted`;
- completion finding/evidence/batch counts equal accepted rows;
- batch sequence numbers and finding/evidence IDs are unique within a run;
- every finding evidence reference resolves within the run or is explicitly rejected;
- a portable run bundle has one run ID shared by all batches and completion;
- terminal run state is immutable;
- repeating an idempotency key with a different payload is a conflict, not a retry;
- a producer authority classification is a claim, not a verified fact;
- secret-bearing evidence is quarantined/rejected according to policy.

## Durable delivery invariants (Milestone 2)

- accepted domain writes and their outbox rows commit or roll back together;
- outbox delivery state is per subscription and event, never a global
  `delivered_at` marker;
- a claim is protected by a lease token and expiry, and a stale worker cannot
  acknowledge or overwrite a newer lease;
- retries are at-least-once and do not create duplicate source events;
- the signed protocol body includes the required `attempt`; retry/replay
  changes the encoded body and signature while preserving source `event_id`,
  payload, `occurred_at`, and payload hash;
- acknowledgements are scoped to the authenticated tenant, consumer, and
  subscription, and exact repeats are idempotent;
- replay creates an audited delivery attempt and does not mutate the source
  event or erase prior failures;
- pull cursors are opaque, scope-bound, and based on a tenant-global monotonic
  delivery position (the historical `stream_position` name may remain); a
  cursor never acknowledges an event;
- metrics and logs use bounded labels and redaction, and never expose source
  content, credentials, or arbitrary routing metadata;
- Supabase Realtime notifications are optional observation aids, not the
  authoritative queue, lease, acknowledgement, or recovery mechanism.

## Producer liveness

A registered stream with an expected cadence owes terminal runs. A missing run is not equivalent to a completed zero-finding run.

- consumer-owned cadence and grace windows are authoritative for health evaluation;
- a stream with no terminal run inside its window is `overdue` and raises a missed-run incident;
- terminal runs include `completed`, `partial`, `failed`, and `cancelled` because all prove the producer executed;
- only `completed` with zero findings means “checked successfully; no changes found”;
- recovered streams resolve, but do not delete, their missed-run incidents;
- liveness state must be computable without trusting producer-supplied schedule metadata.

The prototype exposes `observation` alongside the health status so consumers
can distinguish `zero_findings` (a completed check), `absent_run` (never seen),
and `partial`/`failed`/`cancelled` degraded outcomes. Missed-run incident
creation is idempotent for an open stream/window; recovery updates the existing
record to `resolved` and never deletes it. Finding and terminal events are
stored as immutable event-shaped records and signed using the pinned replay
window constants.

The M2 implementation gate is green in this repository: architecture 4, pure
conformance 6, live PostgreSQL 3, protocol-runtime 5, delivery-core 18,
delivery-consumer 10, persistence 11, webhook adapter 8, worker 6, and API 5,
with clean installs and builds passing. The transport-neutral API still has no
deployable HTTP server, the worker still has no production process/CLI
entrypoint, and observability exporter/deployment remains future operational
work. See `docs/12_milestone_2_delivery.md` for the accepted gate and caveats.
