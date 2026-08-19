# Agent Feed ADR index

These ADRs describe the accepted durable-delivery design and the Milestone 3,
4, and 5 SDK, adapter, capability, reference-consumer, operator, portability,
and operations boundaries. Reviewed against the combined implementation
checkout on **2026-08-18**.

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
| [0010](0010-chatgpt-scheduled-task-mcp-tunnel.md) | Reuse the stdio MCP server for ChatGPT Scheduled Tasks through Secure MCP Tunnel | Accepted; private live acceptance complete |
| [0011](0011-m5a-operator-runtime-boundary.md) | Keep GitHub setup local, private, non-destructive, and separate from account operations | Accepted; local, integrated, and hosted gates green |
| [0012](0012-universal-remote-mcp-gateway.md) | Reuse the official MCP tool factory behind authenticated Streamable HTTP | Accepted and implemented locally; live Claude receipt pending |

Implementation status is tracked in `docs/12_milestone_2_delivery.md`,
`docs/13_milestone_3_mcp_sdks_adapters.md`,
`docs/14_milestone_4_reference_consumer.md`,
`docs/15_milestone_5a_installability.md`, and
`docs/16_milestone_5_portability_operations.md`, and
`docs/17_milestone_6_universal_remote_mcp.md`. M2 is accepted, M3 and M4
are merged with hosted gates green, M5A has local/integrated/hosted
installability evidence, and the remaining M5 reference/contract slices have
local and live PostgreSQL evidence. A local PostgreSQL-compatible Supabase proof is
not hosted production proof; production deployment, tenant-scoped liveness,
metrics sample providers, dashboard authentication, artifact-provider cleanup,
SQLite multi-process durability, and hosted Supabase receipts remain separate
follow-ups. M6 adds a reusable authenticated remote MCP edge without changing
the three-tool lifecycle policy; its embedded OAuth provider remains a
memory-only pilot pending durable identity and hosting. Any
implementation that conflicts with these records must add a new ADR or an
explicit superseding decision; it must not silently change protocol, scope,
cursor, acknowledgement, failure-preservation, capability, or
operator-security semantics.
