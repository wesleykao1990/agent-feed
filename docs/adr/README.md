# Agent Feed ADR index

These ADRs describe the Milestone 2 durable-delivery design and its accepted
implementation boundaries. Reviewed against the combined acceptance checkout
on **2026-08-18**.

Each ADR records context, the decision, rejected alternatives, consequences,
and the tests or operational evidence required to validate it. New decisions
are added as new numbered files; accepted decisions are not silently rewritten.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-m2-module-boundaries.md) | Keep pure delivery behavior, persistence, worker, and API adapters separate | Accepted and implemented; operational deployment follow-up |
| [0002](0002-postgres-outbox-and-lease-queue.md) | Use an atomic PostgreSQL outbox and per-attempt leases for the first queue adapter | Accepted and implemented; explicit migration pair retained |
| [0003](0003-at-least-once-ack-and-replay.md) | Preserve immutable event IDs and make attempts/ack/replay idempotent | Accepted and implemented |
| [0004](0004-subscription-filtering-and-consumer-isolation.md) | Scope every subscription and delivery operation to one consumer/tenant | Accepted and implemented |
| [0005](0005-signature-trace-and-pull-cursor-contract.md) | Keep protocol `0.1` event bodies stable; use transport metadata and opaque cursors | Accepted and implemented |

Implementation status is tracked in `docs/12_milestone_2_delivery.md` and the
combined acceptance matrix. The current decision is **GO for the M2
implementation gate in this repository**; transport deployment, observability
export, explicit migration-pair expansion, hosted GitHub CI execution, and
release packaging remain separate follow-ups. Any implementation that conflicts with these records must
add a new ADR or an explicit superseding decision; it must not silently change
protocol, scope, cursor, or acknowledgement semantics.
