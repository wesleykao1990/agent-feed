# Milestone 12 bugs

| ID | Finding | Resolution |
|---|---|---|
| M12-001 | The first recommendation normalizer inferred the validated kind as a general string, failing the strict public union build. | Annotate the normalized value with the exact recommendation-kind union; all focused tests and the strict build pass. |
| M12-002 | A syntactically controlled reference could still use a credential-shaped path, and append accepted structurally typed but mutable historical records. | Reject secret-shaped reference segments and require normalized, deeply frozen existing ledger records. |
| M12-003 | The sandboxed foundation rerun could not read the existing `uv` cache. | Rerun the unchanged validator through the approved cache boundary; validation passed without a skip or dependency change. |
