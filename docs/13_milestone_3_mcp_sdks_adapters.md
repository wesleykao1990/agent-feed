# Milestone 3 — MCP, SDKs, and adapters

Status: **implementation and hosted CI gates green**
Branch: `agent/milestone-3-mcp-sdks-adapters`
Baseline: merged Agent Feed `ad7e1a7` (`schema-v0.1.1`)

## Scope

Milestone 3 adds producer-facing MCP and adapters, producer/consumer SDKs in
TypeScript and Python, accurate agent skills, and a capability-gated ChatGPT
Scheduled Task export path. It does not implement the Rewards Optimizer and it
does not turn the transport-neutral delivery handlers into a claimed production
HTTP deployment.

## Required deliverables

| Area | Required result | Status |
|---|---|---|
| MCP | Executable `begin_run`, `submit_batch`, and `complete_run` tools over the public producer service | Passed locally |
| TypeScript SDK | Independently buildable producer/consumer SDK with injected transport and safe retries | Passed locally |
| Python SDK | Python 3.11+ producer/consumer SDK with checked protocol models and safe retries | Passed locally |
| REST adapter | Reusable producer client/adapter aligned with the durable API | Passed locally |
| Local-file adapter | Validated bundle import with explicit mid-run failure preservation | Passed locally |
| Generic webhook | Authenticated normalization with bounded input and failure preservation | Passed locally |
| Claude hook | Lifecycle mapping that closes or preserves partial/failed runs | Passed locally |
| ChatGPT manual export | Protocol-valid tool-less run-bundle construction and validation | Passed locally |
| Skills | ChatGPT and Claude instructions aligned with real capabilities and trust boundaries | Passed locally |
| Scheduled Task path | Installed-plugin MCP capability gate with Secure MCP Tunnel operator path and run-bundle fallback | Repository path passed; live account connection is an operator step |

## Acceptance matrix

No row is accepted from source presence alone. Evidence requires executable
tests in the integrated checkout.

| ID | Acceptance requirement | Required evidence | Status |
|---|---|---|---|
| M3-A01 | REST and MCP call the same producer application service. | Behavioral spy/real-service test plus architecture import scan. | Passed locally |
| M3-A02 | The MCP surface exposes exactly the supported lifecycle tools with stable, redacted errors. | MCP protocol/list/call/invalid-input tests. | Passed locally, 10/10 |
| M3-A03 | A tool-less agent can produce an importable run bundle. | Manual-export fixture validates and imports through local-file adapter. | Passed locally |
| M3-A04 | Failure after begin does not silently disappear. | Injected failure after begin and after batch closes partial/failed or returns durable recovery material. | Passed locally |
| M3-A05 | Exact retry of recovery material is safe. | Replay test proves no duplicate accepted lifecycle rows/receipts. | Passed locally |
| M3-A06 | TypeScript producer and consumer APIs are usable without server/database imports. | Clean install/build/test, packed external import, and architecture scan. | Passed locally, 5/5 |
| M3-A07 | Python producer and consumer APIs are usable without server/database imports. | Isolated Python test/package build and schema-drift check. | Passed locally, 10/10 plus wheel |
| M3-A08 | Retry is bounded and only used for safe/idempotency-protected operations. | Timeout, abort, retry-budget, and unsafe-write tests in both SDKs. | Passed locally |
| M3-A09 | Generic webhook verifies upstream authenticity before lifecycle writes. | Invalid/stale/replayed/tampered signature tests and no-call assertions. | Passed locally, 7/7 |
| M3-A10 | Adapter/SDK errors do not leak credentials, evidence excerpts, or payloads. | Adversarial redaction corpus across public errors/recovery output. | Passed locally |
| M3-A11 | Scheduled Task behavior is capability-gated. | Direct-capability and no-capability fixtures; installed-plugin/tunnel runbook; no unsupported delivery claim. | Passed locally; live connection requires operator account setup |
| M3-A12 | Existing M0-M2 correctness remains green. | Foundation, prototype, M1 live ingress, M2 live delivery, checksum, compatibility, and type gates. | Passed locally |
| M3-A13 | Package boundaries do not require immediate refactoring. | Final modularity audit, no circular/direct-source imports, clean package installs. | Passed locally |
| M3-A14 | Hosted CI reproduces the complete gate. | Green GitHub Actions run for the reviewed source commit. | Passed — run `32089066103`, source `52594aa` |

## Dependency direction

```text
schema/types ────────────────> TypeScript SDK
       │                      Python checked models
       │
       └─> producer-service ─> REST API
                          ├──> MCP server
                          └──> producer adapters

delivery-consumer contract ─> consumer SDK transports
```

MCP, SDKs, and adapters do not depend on PostgreSQL. Executable server
composition may inject the existing durable adapter at the outermost boundary.

## Evidence record

The no-skip M3 gate passed locally with architecture 4, cross-boundary
behavioral conformance 12, producer service 9, API 2, MCP 10, TypeScript SDK 5,
Python SDK 10 plus an isolated wheel build/install/import, REST 4, local-file
10, generic webhook 7, Claude hook 5, and ChatGPT manual export 6. The complete M0-M2
regression also passed against disposable PostgreSQL with no live-test skips.
Exact commands and environment evidence are in `docs/m3/ACCEPTANCE.md`.

Hosted GitHub Actions run `32089066103` passed the complete clean-checkout gate
on reviewed source commit `52594aa` in draft PR #4. All acceptance rows are
green; the pull request intentionally remains unmerged for human review.

Supporting records:

- `docs/adr/0006-m3-shared-producer-service-boundary.md`
- `docs/adr/0007-m3-sdk-transport-and-version-boundary.md`
- `docs/adr/0008-m3-failure-preservation-and-capability-gating.md`
- `docs/m3/DECISIONS.md`
- `docs/m3/BUGS.md`
- `docs/m3/LEARNINGS.md`
- `docs/m3/REFACTOR_DEBT.md`
