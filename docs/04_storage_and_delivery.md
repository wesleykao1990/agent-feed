# Storage and delivery

## Recommended production boundary

Agent Feed is a separate deployable service and owns its own database. Consumer applications communicate through versioned HTTPS/MCP contracts, never by querying Agent Feed tables.

For local development, both projects may run on one machine or one temporary Postgres instance, but integration tests must still use the public protocol boundary.

## Data model

Core tables:

- runs;
- batches;
- findings;
- submitted_evidence;
- finding_evidence;
- outbox_events;
- consumer_subscriptions;
- delivery_attempts;
- acknowledgements.

Milestone 1's in-memory prototype keeps liveness incidents and protocol events
behind the same shape a durable adapter would use. A missed-run incident is
opened once per stream/window, remains in the incident ledger after recovery,
and is updated to `resolved` when any terminal run proves that the producer
executed. Finding and terminal-run events are append-only records; reads return
copies so a caller cannot mutate accepted payloads.

## Outbox and queue

M2 design requires the batch transaction to write findings/evidence and the
immutable outbox event atomically. One event fans out into independent
per-subscription delivery state; the legacy global `delivered_at` column is not
an acknowledgement source of truth. A queue worker claims a leased delivery
row, sends the signed event, and persists acknowledgement, retry, or
dead-letter state. A queue message is only a wake-up hint; the database remains
the durable source of truth.

External delivery is at-least-once. A 2xx response is treated as acknowledged
only under the consumer contract that the receiver durably recorded its event
ID before responding. The protocol event's required `attempt` field is part of
the signed body, so each retry/replay changes raw bytes and signature while
preserving event ID, payload, occurred time, and payload hash.

Current implementation status: the additive `0002` schema shape, tenant-global
delivery-position path, transaction-aware ingress outbox writer, PostgreSQL
delivery repository, pure retry worker, delivery-worker composition root,
cursor, metrics sink, protocol runtime, consumer service, transport-neutral API
handlers, and webhook network adapter are implemented. The latest local
evidence is architecture 4, pure 6, live PostgreSQL 3, protocol 5, core 18,
consumer 10, persistence 11, webhook 8, worker 6, and API 5. The corrected
serialized live gate and all seven clean package installs/builds/tests pass.
Hosted GitHub Actions CI run #5 passed on draft PR #2 for commit `ad4ea3a`. A
deployable worker process, HTTP server, and production
observability exporter remain future operational work. Migration loading is
intentionally explicit `0001`, `0002`, then `0003`; arbitrary directory
discovery/gap checking is outside this implementation gate.

## Realtime

Realtime is optional for live admin screens such as “run in progress” or “five
findings received.” It is never the durable delivery mechanism, acknowledgement
source, retry scheduler, or recovery source. M2 architecture tests enforce that
delivery-core and protocol-runtime do not import Realtime/Supabase.
