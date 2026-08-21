# Large-run scaling decisions

| ID | Decision | Reason |
|---|---|---|
| LR-D001 | Keep protocol `0.1` and ingress limits unchanged. | Repeated bounded batches already express the need; larger requests weaken the security boundary. |
| LR-D002 | Make the unit, not an arbitrary item count, the indivisible planning boundary. | A newly introduced evidence record must not be stranded behind its finding. |
| LR-D003 | Derive batch and idempotency identity from canonical ordered content. | Restart must regenerate an exact retry without a new mutable ledger. |
| LR-D004 | Submit sequentially and checkpoint after the durable receipt. | This supplies natural backpressure and does not outrun the producer rate limit. |
| LR-D005 | Leave completion explicit. | A generator or callback failure must never be represented as a successful terminal run. |
| LR-D006 | Keep family/role coverage outside Agent Feed. | The P0 vocabulary and authority decisions belong to the Rewards consumer. |
| LR-D007 | Persist target attempts in an additive, generic sidecar with an immutable tenant-scoped run/deployment binding and derived latest/last-resolved projections. | Resumable jobs need durable retry evidence tied to one registered deployment, while a later transport failure must not erase an earlier resolution or introduce provider/domain vocabulary. |
