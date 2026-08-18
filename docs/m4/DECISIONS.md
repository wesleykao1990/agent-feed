# Milestone 4 decision log

Started: 2026-08-18. This log is append-only.

| ID | Decision | Reason | Verification |
|---|---|---|---|
| M4-D001 | Keep the actual Rewards Optimizer outside this repository; implement only the generic reference at the roadmap's historical example path. | Domain schema, persistence, review, and deployment belong to the consumer. | Architecture checker prohibits reward/canonical/promotion outputs. |
| M4-D002 | Import only the public TypeScript SDK package. | The example must be portable and must not depend on Agent Feed server or private implementation code. | Dependency/import scans and clean build. |
| M4-D003 | Require caller-supplied tenant and non-empty stream allowlist. | Delivery body data cannot authorize its own scope. | Scope construction and unauthorized-stream tests. |
| M4-D004 | Separate transport receipts from versioned semantic keys. | At-least-once event identity and claim equivalence answer different questions. | Replay, semantic duplicate, tenant, and stream tests. |
| M4-D005 | Exclude only `attempt` from the immutable transport fingerprint. | A retry may increment attempt; any other change under one event ID is a conflict. | Exact-retry and payload-drift tests. |
| M4-D006 | Preserve claims, evidence, flags, restrictions, and unknown attributes as cloned untrusted data. | A generic transport cannot establish truth or invent domain meaning. | Hostile and unknown-attribute tests. |
| M4-D007 | Expose no promotion or verification operation. | Review and canonical evidence policy belong to the downstream application. | Public export and forbidden-output checks. |
| M4-D008 | Keep M4 CI Node-only and independent of PostgreSQL. | The reference boundary uses the SDK contract, not Agent Feed persistence. | Separate `milestone-4-reference` workflow job. |
| M4-D009 | Use in-memory stores only as replaceable reference ports and state that they are not production durability. | Adding a consumer database would violate the milestone boundary. | README, acceptance scope, and architecture guard. |
