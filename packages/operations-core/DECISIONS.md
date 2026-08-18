# Operations-core decisions

| ID | Decision | Reason |
| --- | --- | --- |
| M5-OC-D001 | Keep retention planning pure and put SQL/deletion behind `RetentionStore`. | PostgreSQL is the current durable reference, while SQLite and Supabase need the same policy semantics without coupling the package to one driver. |
| M5-OC-D002 | Require a tenant ID and treat tenant mismatch as a skip or error. | A retention job must never become an all-tenant delete primitive. |
| M5-OC-D003 | Default execution to dry-run; the destructive adapter is called only with `{ dryRun: false }`. | Operators need a reviewable preview, and a package default should fail safe. |
| M5-OC-D004 | Legal holds and non-terminal records always veto deletion. | Run completion and legal retention decisions are separate from wall-clock age. |
| M5-OC-D005 | Export audit metadata as canonical NDJSON with a content hash; do not accept raw protocol payloads. | Stable bytes support verification while keeping findings/evidence content out of an operations export. |
| M5-OC-D006 | Leave existing append-only schema mutation/deletion decisions to the storage adapter. | Current migrations deliberately protect accepted protocol rows; the pure package cannot safely invent archival semantics. |
| M5-OC-D007 | Permit deletion candidates only for `managed_artifact`; treat protocol, delivery, and liveness entities as protected history. | The existing schema protects accepted rows and delivery/audit receipts. A generic delete candidate would be an unsafe bypass. |
| M5-OC-D008 | Cap a plan at 500 deletion candidates and reject duplicates before adapter execution. | Retention jobs need bounded transactions and a caller-forged plan must not amplify deletes. |
| M5-OC-D009 | Propagate candidate overflow as an error and recompute the plan ID at execution. | An overflow skip or stale plan ID could hide work or authorize a changed deletion set. |
| M5-OC-D010 | Bound audit exports to 1,000 records/1 MiB and reject sensitive key substrings recursively. | Export size must be predictable and nested operator metadata must not become a payload/credential exfiltration path. |
| M5-OC-D011 | Normalize once and use canonical record bytes as the final audit sort key. | Timestamp/type/ID/action are not a total order; equal primary keys otherwise preserve caller input order and change the export hash. |
| M5-OC-D012 | Scan audit string values as well as keys for credential schemes, signed URLs, and recognizable API secrets. | A safe-looking metadata key can still carry a Bearer token, URL password, signature, or provider key. |
