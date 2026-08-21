# Milestone 12 bugs

| ID | Finding | Resolution |
|---|---|---|
| M12-001 | The first recommendation normalizer inferred the validated kind as a general string, failing the strict public union build. | Annotate the normalized value with the exact recommendation-kind union; all focused tests and the strict build pass. |
| M12-002 | A syntactically controlled reference could still use a credential-shaped path, and append accepted structurally typed but mutable historical records. | Reject secret-shaped reference segments and require normalized, deeply frozen existing ledger records. |
| M12-003 | The sandboxed foundation rerun could not read the existing `uv` cache. | Rerun the unchanged validator through the approved cache boundary; validation passed without a skip or dependency change. |
| M12-004 | Node PostgreSQL tests failed with `EPERM` even though the isolated database was healthy. | Rerun the unchanged suite outside the loopback-restricted sandbox; all 20 PostgreSQL package tests passed. |
| M12-005 | The first live Codex invocation placed the global approval flag after `exec`, which this CLI rejects. | Place `-a never` before `exec`; the ephemeral read-only credential smoke then returned the exact receipt. |
| M12-006 | A cached Codex ChatGPT login was available, but no `OPENAI_API_KEY` was exported. | Keep the credential probes distinct: prove Codex login with `codex exec`, and skip (or explicitly require) the API-key probe without reading cached token files. |
| M12-007 | Initial database projection checks could accept extra JSON keys or collapse missing/null comparisons through SQL three-valued logic if a privileged caller recomputed the hash. | Require exact keys at every object level, use null-safe `is distinct from` projections, and add a hostile direct-SQL test with a self-consistent hash. |
