# ADR-0002: PostgreSQL outbox and lease queue

- Status: Accepted for implementation; code not yet complete
- Date: 2026-08-18
- Scope: First durable delivery adapter

## Context

The M1 schema has a reserved `agent_feed.outbox_events` table, but M1 does not
write it. Its `delivered_at` field is global and cannot represent independent
delivery state for multiple consumers. A finding must not disappear merely
because one consumer is offline.

The repository currently loads one fixed migration file. An M2 schema needs an
ordered, repeatable migration path without rewriting the M1 baseline.

## Decision

Add an additive `0002_durable_delivery.sql` migration and a migration-directory
loader. Keep `0001_agent_feed.sql` historical and idempotent. The new delivery
repository owns SQL for immutable outbox events, consumer subscriptions,
per-subscription attempts, acknowledgements, dead letters, and cursors.

Accepted M1 writes and outbox rows are committed in the same PostgreSQL
transaction. The worker claims pending attempts with a bounded lease using
`FOR UPDATE SKIP LOCKED` or an equivalent adapter port. Lease expiry returns
work to the pending state.

Delivery state is keyed by `(subscription_id, event_id)`; the legacy global
`delivered_at` column is not an acknowledgement source of truth.

## Rejected alternatives

- Mark the outbox event globally delivered after the first consumer succeeds:
  loses events for all other consumers.
- Use an HTTP call inside the ingress transaction: external latency/outage
  would block or roll back accepted producer data.
- Use a process-local queue: restart loses pending work.
- Replace the M1 migration in place: makes existing installations and audit
  history ambiguous.
- Make Supabase Realtime the queue: it is a projection channel, not durable
  work storage.

## Consequences

The first production adapter is PostgreSQL-backed and requires a migration
runner. Worker throughput depends on the database claim indexes and lease
duration. A later PGMQ/SQS adapter can implement the same delivery-core ports;
the event and acknowledgement semantics remain unchanged.

## Validation

- clean and existing-M1 migration tests;
- failed batch rollback proves no findings/evidence/outbox partial state;
- exact ingress retry proves no duplicate outbox rows;
- concurrent workers cannot claim one attempt twice;
- expired leases are reclaimable;
- outbox payloads are immutable and per-consumer state is independent.
