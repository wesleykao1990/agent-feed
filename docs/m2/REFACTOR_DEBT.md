# Milestone 2 modularity and refactor-debt audit

Reviewed: **2026-08-18**  
Status: **M2 implementation gate passed; remaining debt is nonblocking operational follow-up**

This audit records whether the current M2 shape has one responsibility per
package and a dependency direction that can be completed without an immediate
rewrite. The durable adapter gate is green; the audit retains only explicit
operational and release-handoff follow-ups.

## Ownership and dependency map

| Boundary | Sole responsibility | Current evidence | Refactor verdict |
|---|---|---|---|
| `packages/schema/contracts` | Versioned protocol schemas and generated contract shape | Existing protocol `0.1` schema remains the compatibility source | Keep stable; no M2 delivery state belongs here. |
| `packages/protocol-runtime` | Canonical JSON, protocol wire encoding, HMAC/replay verification, key-ring primitives | 5/5 tests; clean install/build; production persistence/worker/webhook paths use the public runtime boundary | Modular; prototype reference helpers remain nonblocking historical code. |
| `packages/delivery-core` | Pure delivery types, selector matching, cursors, retry policy, lease/ack state machine, worker ports, bounded test metrics sink | 18/18 tests; clean install/build; no SQL/network/Realtime imports; live repository acceptance green | Modular; keep persistence and process lifecycle out. |
| `packages/delivery-consumer` | Consumer-facing application service, scope checks, subscription lifecycle, pull/ack/DLQ/replay ports | 10/10 tests; clean install/build; live scope/cursor acceptance green | Modular and accepted; HTTP transport remains outside the package. |
| `packages/persistence-postgres` | SQL migrations and PostgreSQL ingress/delivery repository adapters | 10/10 tests with PostgreSQL; transactional outbox, leases, replay, cursors, and tenant scope pass | Modular and accepted; explicit `0001`/`0002` loading is intentional. |
| `packages/webhook-adapter` | DNS/endpoint validation, fixed-address HTTP, timeout/body/redirect safety, and HTTP retry classification | 8/8 tests; clean install/build | Modular and accepted; production process/exporter deployment is future work. |
| `apps/delivery-worker` | Process lifecycle, claim loop, leases, transport, signing-key wiring, shutdown, exporter | 6/6 tests; clean install/build; live repository behavior green through combined suite | Composition boundary accepted; no production process/CLI entrypoint yet. |
| `apps/delivery-api` | Transport-neutral consumer handlers and error/status mapping | 5/5 tests; clean install/build; no HTTP server or database code by design | Application boundary accepted; add an HTTP transport only as future operational work. |
| `prototype` | Dependency-light M1/reference lifecycle and liveness behavior | Still in-memory and retains older canonical/signing helpers | Keep as a reference; delegate shared protocol primitives rather than importing runtime internals into delivery core. |
| `docs/` | ADRs, status, operational procedures, bug/learnings and acceptance evidence | M2 docs/ADR/logs reconcile the green implementation gate and retained caveats | Keep docs next to boundaries; update status with every implementation change. |

The intended direction is:

```text
schema/contracts -> protocol-runtime -> delivery-core
                                      -> delivery-consumer -> apps/delivery-api
                                      -> apps/delivery-worker
                                      -> persistence-postgres (ports only)
```

Persistence is an adapter of ports, not a dependency of the pure core. API
and worker code must call application ports and must not issue SQL directly.
The prototype and Rewards Optimizer remain outside this graph.

## Objective checks performed

The following checks were run or are represented by repository tests on
2026-08-18:

- `node --test tests/delivery/*.test.mjs`: **4/4 pass**;
- `packages/protocol-runtime`: **5/5 tests pass**, `npm run build` passes;
- `packages/delivery-core`: **18/18 tests pass**, `npm run build` passes;
- `packages/delivery-consumer`: **10/10 tests pass**, `npm run build` passes;
- `packages/persistence-postgres`: **10/10 tests pass** with the disposable
  PostgreSQL database configured;
- `packages/webhook-adapter`: **8/8 tests pass**, `npm run build` passes;
- `apps/delivery-worker`: **6/6 tests pass** with clean install/build;
- `apps/delivery-api`: **5/5 tests pass** with clean install/build; the
  transport-neutral boundary does not claim a running HTTP server;
- `node scripts/check_delivery_architecture.mjs`: strict boundary scan passes
  for the paths present in the checkout.
- `tests/delivery/conformance.test.ts`: **6/6 pure conformance tests pass**;
- `tests/delivery/postgres-conformance.test.ts`: **3/3 live PostgreSQL tests
  pass** with the acceptance database configured;
- `scripts/run_m2_conformance.mjs`: architecture 4, pure 6, live PostgreSQL 3,
  and all package/application suites pass in the combined gate.

These checks prove the current repository implementation gate, including live
transactional delivery behavior. They do not claim that hosted GitHub CI has
run, that an HTTP server or production worker process is deployed, or that a
production observability exporter is wired.

## Remaining refactor debt

| Debt | Why it matters | Containment and acceptance proof |
|---|---|---|
| Historical canonical JSON/HMAC helpers in the in-memory prototype | Reference-only duplicate code could drift if reused as production runtime | Production persistence/worker/webhook paths use protocol-runtime; keep prototype isolated and add parity checks if it becomes a production adapter. Nonblocking. |
| Selector normalization/parity | Core and consumer historically diverged; direct source import could hide package drift | Shared normalized contract, multi-stream/tag/event matrix, package-boundary checks, and combined acceptance are green. Retain regression tests. |
| Cursor position has both legacy per-stream and new tenant-global paths in the schema foundation | Compatibility readers may misinterpret the old coordinate | Keep `delivery_position`/tenant counter authoritative; live multi-stream cursor acceptance is green. Retain schema compatibility tests. |
| Explicit migration pair rather than arbitrary directory discovery | Future migrations need an explicit ordering/gap policy | Keep the tested `0001` → `0002` loader; add discovery only when a future migration set requires it. Nonblocking. |
| No deployable worker/live external transport process | Composition code is accepted, but deployment wiring and endpoint operations are not part of this repository gate | Add a production CLI/process and endpoint rollout when operational deployment begins. Nonblocking. |
| Production metrics exporter/deployment | Bounded test sink and labels pass, but no production exporter is wired | Define exporter allowlists and deployment integration during operations work. Nonblocking. |
| Hosted CI execution | The workflow definition covers all seven M2 packages/apps and requires live PostgreSQL, but hosted execution has not been observed | Run/record GitHub Actions after the branch is pushed; do not treat local evidence as a hosted CI result. Nonblocking. |
| Hosted CI and release handoff | Local evidence cannot prove the remote workflow result | Push the draft PR, observe GitHub Actions, and record the result before handoff. Nonblocking for local implementation; required for PR handoff. |

## Conclusion

The current layout has acceptable single-responsibility boundaries, and the
M2 implementation gate is **GO**. No package-graph refactor is required. The
remaining items are explicitly nonblocking operational or release-handoff
work: a deployable worker/HTTP transport, production metrics exporter,
arbitrary future migration discovery, hosted GitHub CI execution, and final
packaging/checksum refresh.
