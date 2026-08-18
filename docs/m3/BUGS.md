# Milestone 3 bug and gap log

Status: local implementation gaps resolved; hosted CI pending
Started: 2026-08-18

This log is append-only. A resolution must name its regression evidence; an
item is not closed merely because source code exists.

| ID | Symptom / evidence | Impact | Required resolution | Status |
|---|---|---|---|---|
| M3-001 | `apps/mcp-server` contains README placeholders only. | MCP cannot call the durable producer application service. | Implement the three lifecycle tools, safe stdio framing/composition, and behavioral tests through the producer-service port. | Open |
| M3-002 | TypeScript and Python SDK directories contain documentation/generated-type foundations but no usable producer and consumer clients. | Producers and consumers must hand-roll transport, retry, and error handling. | Add independently testable SDK packages with injected transports, exact protocol pinning, bounded retries, and redaction. | Open |
| M3-003 | Claude-hook, REST, generic-webhook, and ChatGPT manual-export adapters are placeholders. | Non-REST and tool-less producer paths are documentation-only. | Implement adapter packages against the shared service/bundle boundary with adversarial tests. | Open |
| M3-004 | The current local-file importer calls begin, batches, and complete sequentially but has no explicit recovery behavior if a later call fails. | A mid-import failure can leave an apparently running run and no standardized recovery artifact. | Add terminal partial/failed closure or deterministic resumable output without changing accepted receipts. | Open |
| M3-005 | No combined M3 architecture/conformance command or hosted CI step exists. | Individual green packages can conceal cross-boundary drift or untested placeholders. | Add a no-skip M3 gate and CI coverage while retaining all M0-M2 gates. | Open |
| M3-006 | Existing skill/readme material does not prove capability-present and capability-absent Scheduled Task behavior. | Documentation could imply an unavailable automatic ingestion path. | Add capability-gated instructions and validated manual-export fallback fixtures. | Open |
| M3-007 | The Milestone 1 status text predates the published `schema-v0.1.1` release. | Handoff documentation can incorrectly describe the release artifact as pending. | Reconcile release facts without claiming the separate Rewards consumer PR is merged. | Open |
| M3-008 | The first MCP implementation negotiated only legacy revision `2025-03-26`. The current MCP revision is `2026-07-28`, which replaces `initialize` with optional `server/discover` and per-request `_meta` envelopes in the modern era. | A new server could pass local tests while already requiring a protocol-era migration. | Use the current official TypeScript server package, serve the modern era, retain tested legacy compatibility, and pin the dependency exactly. | Open — found during orchestrator standards review |
| M3-009 | The first REST adapter implementation duplicated the complete request router already present in `apps/api`. | Two HTTP implementations would drift and create immediate refactor debt. | Make `packages/adapters/rest` the reusable transport boundary and retain `apps/api` only as the executable/compatibility composition wrapper. | Resolved locally; combined M1/M3 regression passed |

## Resolution record

The table above preserves the initial observations. Resolutions validated on
2026-08-18:

| ID | Resolution | Regression evidence | State |
|---|---|---|---|
| M3-001 | Added an executable stdio MCP server backed by the public producer service and the official TypeScript MCP server package. | MCP 10/10; architecture and cross-boundary suites. | Resolved locally |
| M3-002 | Added independently buildable TypeScript and Python producer/consumer SDKs with injected transports. | TypeScript 5/5 including packed import; Python 10/10 plus isolated wheel install/import. | Resolved locally |
| M3-003 | Implemented REST, signed generic-webhook, Claude-hook, and ChatGPT manual-export packages. | Adapter suites 4/4, 7/7, 5/5, and 6/6. | Resolved locally |
| M3-004 | Local-file imports now attempt terminal failure closure and emit deterministic recovery material when closure is unavailable. | Local-file 10/10 plus cross-boundary recovery replay. | Resolved locally |
| M3-005 | Added `m3:architecture` and a no-skip `m3:conformance` runner; CI installs M3 dependencies and executes it. | Local M3 gate passed; hosted CI pending. | Resolved locally |
| M3-006 | Rewrote both skills around explicit capabilities and a validated run-bundle fallback. | Capability-present/absent conformance fixtures. | Resolved locally |
| M3-007 | Reconciled Milestone 1 documentation with the published immutable schema release while leaving Rewards status to its repository. | Documentation and manifest review. | Resolved locally |
| M3-008 | Upgraded the executable path to exact `@modelcontextprotocol/server@2.0.0`, modern discovery/meta, and tested legacy compatibility. | Public stdio MCP conformance and dependency lock. | Resolved locally |
| M3-009 | Moved reusable routing to `@agent-feed/rest-adapter`; `apps/api` is now only the existing composition/compatibility wrapper. | API 2/2, REST 4/4, M1 ingress 5/5, architecture guard. | Resolved locally |

## Bugs encountered during integration

| ID | Observation | Resolution and retained evidence |
|---|---|---|
| M3-010 | The first cross-suite MCP fixture exercised only the deterministic internal legacy facade, so it could not prove the public executable served the modern MCP era. | The fixture now launches the public `serveAgentFeedMcpStdio` path and verifies modern `server/discover`, per-request metadata, and tool calls; legacy behavior remains a separate compatibility test. |
| M3-011 | The initial root M3 runner omitted the established `apps/api` wrapper and did not prove that the Python SDK could build and install a clean artifact. | Added API build/test plus isolated source-copy wheel build, clean-environment install, and external import to the mandatory no-skip runner. |
| M3-012 | The first Python wheel attempt lacked its declared `setuptools` backend in the disposable validation environment. | Added the bounded backend to `requirements-dev.txt`; the isolated wheel build now passes without writing build metadata into the source tree. |
| M3-013 | Four loopback-server tests reported `EPERM` under the restricted local sandbox even though no assertion ran. | Re-ran the same unmodified prototype/API suites with approved loopback access; all 29 prototype and 2 API tests passed. This was an execution-environment constraint, not a product-code defect. |
| M3-014 | Concurrent package construction briefly exposed a TypeScript SDK dependency mismatch before every owned package and lockfile had landed. | Integration is judged only after the shared worktree reached a stable state; clean package builds and the complete no-skip M3 gate pass. |
| M3-015 | The first architecture fixture made `apps/mcp-server/src/main.ts` optional and could accept a production entrypoint that wrapped the internal legacy facade in a function named `serveStdio`. | The guard now requires `main.ts`, the official stdio import, the official SDK server factory, and rejects the internal facade import; its adversarial fixture retains the regression. |
| M3-016 | The TypeScript SDK initially exported raw `.ts` source after a no-emit build, and its newly added packaging smoke was outside the root gate. | The package now emits declarations/ESM to clean `dist`, exports only compiled files, and executes a packed-package import in an ordinary Node consumer as part of its required test script. |
| M3-017 | Recovery bundles were enumerable properties on four public error classes, so generic error serialization could emit the complete evidence bundle. | Recovery remains explicitly accessible but is non-enumerable; each error has safe `toJSON()` output and adversarial serialization tests. |
| M3-018 | ChatGPT default IDs depended only on response text, causing identical text from different contexts or occurrence times to reuse keys with different bodies. | Canonical occurrence/context identity now drives run, batch, evidence, and idempotency keys; exact retry guidance requires reusing the bundle or stable explicit identity inputs. |
| M3-019 | Claude reported a successfully closed partial failure as `run.completed`. | Partial closure now returns `run.partial`; begin ambiguity is also preserved as resumable recovery. |
| M3-020 | Local-file byte input used replacement-character UTF-8 decoding and begin failures were treated as definitely side-effect-free. | Fatal decoding rejects malformed bytes before lifecycle calls; an uncertain begin outcome now returns/persists exact recovery material. |
| M3-021 | Generic webhook mappers received raw credential/signature headers and adapter serialization exposed its configured secret; replay protection did not cross processes. | Secrets are private, mapper headers are allowlisted, stable event IDs are mandatory, process-local replay is rejected, and an injected atomic replay store covers cross-instance durability. |
| M3-022 | REST's class wrapper dropped `service_name` and rejected SDK-encoded slash-containing wire IDs. | Class and factory now share options; percent-encoded slash data is accepted while literal path separators still cannot match the route. |
| M3-023 | Python `ProducerRun` retained a failed batch and could not export partial progress; optional recovery timestamps could drift under one key. | Only successful batches are recorded, explicit partial bundles are supported, and both idempotency key and completion timestamp are required. |
| M3-024 | The local-file lockfile retained obsolete PostgreSQL dependency metadata from the pre-M1 producer-service graph. | Regenerated the lockfile from current manifests; the adapter remains database-neutral. |
| M3-025 | Hosted PR #4 built `apps/api` before installing the source-linked REST adapter's own dependency graph. A populated local checkout masked the missing clean-install prerequisite. | Moved the REST adapter install into the API/Milestone 1 dependency phase and removed the later duplicate install. The API is now built only after all source-linked package dependencies are present; the updated hosted workflow is the clean-checkout regression. |

Public diagnostics are redacted. Recovery bundles intentionally preserve the
original evidence required for exact replay and therefore belong in a secured,
access-controlled recovery store.
