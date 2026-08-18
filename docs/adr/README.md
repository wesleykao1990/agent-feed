# Agent Feed ADR index

These ADRs describe the accepted durable-delivery design and the Milestone 3
and 4 SDK, adapter, capability, and reference-consumer boundaries. Reviewed against the
combined implementation checkout on **2026-08-18**.

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
| [0006](0006-m3-shared-producer-service-boundary.md) | Share one producer application boundary across REST, MCP, and producer adapters | Accepted and implemented; hosted CI green |
| [0007](0007-m3-sdk-transport-and-version-boundary.md) | Keep SDKs transport-injected and protocol-version pinned | Accepted and implemented; hosted CI green |
| [0008](0008-m3-failure-preservation-and-capability-gating.md) | Preserve partial adapter work and gate automation by actual capability | Accepted and implemented; hosted CI green |
| [0009](0009-m4-reference-consumer-trust-boundary.md) | Keep the generic consumer untrusted, scoped, portable, and separate from the Rewards app | Accepted and implemented; hosted CI green |

Implementation status is tracked in `docs/12_milestone_2_delivery.md` and
`docs/13_milestone_3_mcp_sdks_adapters.md`, and
`docs/14_milestone_4_reference_consumer.md`. The current decision is **GO for the M2
implementation gate in this repository**; transport deployment, observability
export, and explicit migration-pair expansion remain separate follow-ups. The
M3 combined local and hosted gates are green; GitHub Actions run `32089066103`
passed on source commit `52594aa` in draft PR #4.
Hosted CI run #5 passed on draft PR #2. Any implementation that conflicts with these records must
add a new ADR or an explicit superseding decision; it must not silently change
protocol, scope, cursor, acknowledgement, failure-preservation, or capability
semantics.
