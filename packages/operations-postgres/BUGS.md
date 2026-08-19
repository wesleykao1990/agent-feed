# Operations PostgreSQL bug and gap log

| ID | Symptom / impact | Resolution or follow-up | Status |
|---|---|---|---|
| OPS-PG-001 | A plan can become stale when a managed artifact receives a legal hold. | Lock the artifact immediately before claim; skip held artifacts; reject legal-hold changes while an item is in progress. | Resolved in package migration and claim path |
| OPS-PG-002 | A worker crash after external deletion can leave an item `in_progress`. | Resume expired claims with the same stable per-item operation ID; external adapters must treat retries as idempotent. | Resolved by claim lease; provider contract required |
| OPS-PG-003 | The existing stream-liveness schema has a global stream primary key. | Do not add misleading tenant columns in this package; keep liveness out of tenant snapshots and use a future trusted metrics adapter. | Accepted boundary |
| OPS-PG-004 | Operations-core rejects `artifact*` detail keys. | Export `mapAuditSourceForOperationsCore` to strip forbidden/sensitive detail keys while preserving typed source identity. | Resolved |
| OPS-PG-005 | A PostgreSQL adapter implementation could be mistaken for production deployment proof. | Require the root migration loader and live disposable PostgreSQL before local acceptance, and hosted operational evidence before a production claim. | Local gate resolved; hosted deployment evidence remains open |
| OPS-PG-006 | A non-claiming concurrent worker initially treated another worker's `in_progress` item as failed and could write a premature terminal job result. | Keep the job `executing` while any live item remains in progress; only terminal item states participate in finalization. | Resolved with live two-worker acceptance coverage |
