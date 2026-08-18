# Operations PostgreSQL decisions

| ID | Decision | Reason | Verification |
|---|---|---|---|
| OPS-PG-D001 | Register external artifacts separately from protocol and delivery ledgers. | Retention must not delete or mutate immutable Agent Feed history. | Additive `0004_operations.sql`; no foreign key or delete path to protocol rows. |
| OPS-PG-D002 | Plan jobs are bounded, durable, and idempotent by `(tenant_id, idempotency_key)`. | Dry-run planning must be repeatable and safe under retries. | Request hash conflict test; max plan limit validation. |
| OPS-PG-D003 | External deletion/tombstoning requires an injected adapter, explicit high-entropy confirmation token, and stable per-item operation ID. | Database code must not own provider credentials or irreversible side effects. | Adapter contract and execution test; raw token never enters SQL values. |
| OPS-PG-D004 | Store only a SHA-256 hash of the confirmation token. | Exact confirmation retries need comparison without retaining the bearer token. | Token-hash assertion and SQL log redaction test. |
| OPS-PG-D005 | Legal holds are checked under an artifact row lock; changing a hold while an item is `in_progress` is rejected. | A hold set between planning and external I/O must not be bypassed. | Migration trigger and claim-path adversarial test. |
| OPS-PG-D006 | Never hold a PostgreSQL transaction across external adapter I/O. | Provider latency or outage must not retain database locks. | Execution event-order test: commit precedes adapter call. |
| OPS-PG-D007 | Audit-source export is metadata-only and deterministically ordered. | Operations export needs lineage without leaking payloads, evidence, receipts, or raw errors. | Bounded union query and mapping tests. |
| OPS-PG-D008 | Do not infer tenant-scoped liveness from globally keyed stream expectations. | The current base schema cannot prove tenant isolation for liveness. | Snapshot returns `liveness: null`; README documents the trusted metrics-adapter boundary. |
