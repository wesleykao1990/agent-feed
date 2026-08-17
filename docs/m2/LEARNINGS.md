# Milestone 2 engineering learnings

Status: **initial observations; append-only**

These entries capture implementation rules derived from the current repository
and the M2 design. Add new entries instead of replacing earlier observations.

| ID | Observation/evidence | Learning | Action |
|---|---|---|---|
| M2-L001 | Delivery is multi-consumer, but M1's outbox placeholder has a single `delivered_at`. | Outbox existence and delivery completion are different facts. Delivery state must be per subscription and event. | Use `(subscription_id,event_id)` as the acknowledgement identity; test independent consumer outcomes. |
| M2-L002 | M1 accepted rows are transactional, but no event rows are written by the ingress service. | A durable outbox is only reliable when it shares the ingress transaction; a post-commit enqueue has a loss window. | Pass a transaction-aware outbox writer into batch/complete application flow. |
| M2-L003 | The protocol schema is strict and snake_case; prototype helpers are camelCase. | Sign exactly the schema-defined wire bytes, not an internal object representation. | Centralize wire conversion and validate the exact signed raw body. |
| M2-L004 | Canonical JSON code is duplicated in three modules. | Small serialization differences become protocol and idempotency bugs. | Extract one runtime canonicalizer; add a cross-package parity test. |
| M2-L005 | The current PostgreSQL loader names one migration file explicitly. | Adding a second migration requires an ordered migration contract, not a second ad-hoc URL. | Implement discovery/order/idempotence tests before operating M2 against a real database. |
| M2-L006 | M1 uses `FOR UPDATE` on run rows for idempotent batch ordering. | Database locking is already the persistence concurrency boundary; M2 can use the same database with `SKIP LOCKED` for worker claims. | Keep queue claims in a repository adapter and test concurrent workers plus lease expiry. |
| M2-L007 | HTTP acknowledgement can be lost after a consumer commits its receipt. | Exactly-once external delivery cannot be promised; at-least-once plus consumer idempotency is the honest contract. | Preserve event ID across retry/replay and require durable consumer receipts before `2xx`. |
| M2-L008 | `DeliveryEvent` already contains `event_id` and `attempt`. | A new protocol body field is not necessary for basic attempt lineage. | Keep trace/attempt state out of the protocol body unless a versioned decision requires it. |
| M2-L009 | Pull pagination can see multiple events with identical timestamps. | Timestamp-only cursors skip or repeat events. | Use an opaque `(created_at,event_id)` cursor scoped to the consumer/subscription. |
| M2-L010 | Prototype, API README, and Supabase docs describe future behavior while executable code is intentionally thin. | Documentation status must distinguish design/reference from implemented behavior. | Every M2 feature gets implementation status, executable evidence, and a validation-report entry before being marked complete. |
| M2-L011 | Checksums cover every tracked file except ignored build/dependency paths. | Documentation and generated artifacts are part of the package integrity contract. | Regenerate `SHA256SUMS.txt` only after code, docs, manifests, and tests settle. |
