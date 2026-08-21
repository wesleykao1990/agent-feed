# Large-run scaling bugs

| ID | Finding | Resolution |
|---|---|---|
| LR-001 | The TypeScript SDK required every producer to implement its own multi-batch loop. | Add one bounded async planner and sequential submission helper. |
| LR-002 | Naive item chunking can emit a finding before evidence introduced later. | Validate references against same/prior units and reject forward or missing references. |
| LR-003 | Random retry batch IDs can turn interruption recovery into conflicting duplicate data. | Derive stable identities from canonical ordered content and fixed plan options. |
| LR-004 | Item-count-only chunking can exceed the HTTP byte limit. | Measure the exact UTF-8 JSON request and split only between atomic units. |
| LR-005 | The published schema permits more evidence than the default durable deployment accepts. | Plan against the stricter deployed 100-evidence default; do not infer the schema maximum is operational capacity. |
| LR-006 | The first broad M3 run was blocked by sandboxed localhost and the host Python lacked `setuptools.build_meta`. | Rerun the unchanged gate outside the loopback restriction with the repository's existing `.venv`; API tests, Python wheel build, and external import passed without skips. |
| LR-007 | Canonical identity initially ignored object key insertion order, but emitted nested objects retained it, so semantically equal plans were not guaranteed byte-equal. | Emit the canonical sorted JSON representation itself and add an adversarial insertion-order retry fixture. |
