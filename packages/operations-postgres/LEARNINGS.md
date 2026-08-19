# Operations PostgreSQL learnings

## OPS-PG-L001 — Deletion should target external artifacts, not immutable history

The protocol and delivery ledgers are audit history. A retention job can mark
an external object deleted or tombstoned while retaining a bounded registry
row, source IDs, hashes, and operation audit events.

## OPS-PG-L002 — Legal-hold checks need a lock and a state guard

A check performed only during planning is insufficient. Claim the artifact and
the job item in a short transaction, then reject hold changes while the item is
in progress. This permits safe provider I/O without holding a database lock
across the network call.

## OPS-PG-L003 — Idempotency spans two systems

Database job keys prevent duplicate plans, but they cannot undo a provider side
effect after a process crash. Every external call therefore receives a stable
job/item operation ID and must make repeated calls safe.

## OPS-PG-L004 — Global liveness cannot be relabeled as tenant-scoped

The current stream expectation primary key is global. A tenant field added only
in an operations package would create a false isolation claim. Liveness remains
an explicit integration follow-up for a trusted tenant-aware metrics adapter.

## OPS-PG-L005 — Audit export should be metadata-first

Source payloads, evidence excerpts, consumer receipts, URLs, and raw errors
belong behind separate access controls. The deterministic audit source query
returns lineage metadata and stable hashes only; an operations-core mapper
removes forbidden artifact/sensitive detail keys before export.
