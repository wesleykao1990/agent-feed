# Milestone 12 decisions

| ID | Decision | Reason |
|---|---|---|
| M12-D001 | Inject authenticated consumer ownership separately from feedback. | A submission body cannot choose its tenant or consumer authority. |
| M12-D002 | Make dispositions events rather than a mutable current-status field. | Surfacing, saving, acting, promotion, and later rejection can all be legitimate history. |
| M12-D003 | Reference targets only by immutable IDs or digest. | Utility evidence must not rewrite producer claims or artifact content. |
| M12-D004 | Represent ratios as exact integer numerator/denominator pairs. | Floating point and zero-denominator conventions would create false comparisons. |
| M12-D005 | Preserve definition and policy scope on every metric snapshot. | Optimization evidence is meaningless if revisions are silently pooled. |
| M12-D006 | Keep recommendations pending, digest-only, and separately approved. | Analysis must not become an unauthorized prompt or schedule mutation. |
