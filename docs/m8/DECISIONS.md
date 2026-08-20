# Milestone 8 decision log

Started: 2026-08-20. This log is append-only.

| ID | Decision | Reason | Verification |
|---|---|---|---|
| M8-D001 | Keep protocol `0.1` immutable and add independent job proof as versioned sidecars. | Assessment vocabulary is not yet universal across providers. | Protocol compatibility and architecture guards. |
| M8-D002 | Put deterministic validation and hashing in `assessment-core`; keep PostgreSQL as the durable adapter. | Policy and assessment semantics need one provider-neutral contract without turning persistence into a workflow engine. | Exact local dependency, core tests, and repository fixtures. |
| M8-D003 | Derive assessor identity/type/independence from one trusted immutable registration version. | A caller-provided independence flag is a claim, not authority. | Self-check rejection, policy gate, and database snapshot trigger. |
| M8-D004 | Keep technical run status separate from the assessment verdict. | Execution proof and quality proof answer different questions. | Run join and completed-plus-failed-quality fixtures. |
| M8-D005 | Represent budget and usage availability explicitly. | Missing telemetry is not numeric zero and cannot imply budget compliance. | State/value/provenance constraints in core and PostgreSQL. |
| M8-D006 | Store hashed artifact identity and bounded provenance, never artifact bytes. | Agent Feed is an evidence ledger, not a general artifact store. | Hostile reference/content fixtures and schema inventory guard. |
| M8-D007 | Represent reassessment as a new immutable receipt linked to the same run and exact policy version. | Updating or replacing prior proof destroys audit history. | Same-run/policy trigger, append-only guards, and run immutability fixture. |
