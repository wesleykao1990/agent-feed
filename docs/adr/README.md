# Agent Feed ADR index

These ADRs describe the Milestone 2 durable-delivery design. They are
decision records, not evidence that the corresponding code is complete.

Each ADR records context, the decision, rejected alternatives, consequences,
and the tests or operational evidence required to validate it. New decisions
are added as new numbered files; accepted decisions are not silently rewritten.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-m2-module-boundaries.md) | Keep pure delivery behavior, persistence, worker, and API adapters separate | Accepted for implementation |
| [0002](0002-postgres-outbox-and-lease-queue.md) | Use an atomic PostgreSQL outbox and per-attempt leases for the first queue adapter | Accepted for implementation |
| [0003](0003-at-least-once-ack-and-replay.md) | Preserve immutable event IDs and make attempts/ack/replay idempotent | Accepted for implementation |
| [0004](0004-subscription-filtering-and-consumer-isolation.md) | Scope every subscription and delivery operation to one consumer/tenant | Accepted for implementation |
| [0005](0005-signature-trace-and-pull-cursor-contract.md) | Keep protocol `0.1` event bodies stable; use transport metadata and opaque cursors | Accepted for implementation |

Implementation status is intentionally tracked in
`docs/12_milestone_2_delivery.md`, not inferred from ADR status.
