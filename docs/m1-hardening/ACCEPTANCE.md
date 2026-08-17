# Milestone 1 corrective-hardening acceptance matrix

Status: **IMPLEMENTATION GATE GREEN — release publication and Rewards pin pending** (2026-08-18)

This matrix is the release gate for durable producer REST ingress and the
schema artifact. A live PostgreSQL skip is not a pass. The branch has passed
the implementation checks below; publication of the tag-gated artifact and
the downstream Rewards Optimizer lockfile pin deliberately remain post-merge
release actions.

| ID | Acceptance area | Evidence | Status |
|---|---|---|---|
| M1H-A01 | Executable API boundary | `npm run m1:architecture`; clean build/test of `packages/producer-service` and `apps/api` (9/9 and 2/2). The producer package owns an adapter-neutral persistence port; handlers compose the PostgreSQL implementation only in the executable API. | Passed locally |
| M1H-A02 | PostgreSQL composition | `AGENT_FEED_DATABASE_URL=... npm run m1:ingress` exercises the public REST entrypoint through migrations `0001`–`0003`. | Passed locally, 5/5 |
| M1H-A03 | Durable restart | The live REST suite stops its first server, launches `apps/api/src/main.ts` in a new OS process with a fresh pool, reruns startup migrations/environment credential composition, reads the same completed run/findings, and exercises SIGTERM cleanup. | Passed locally |
| M1H-A04 | HTTP idempotency/conflict | Live REST exact begin/batch/complete retry receipts, payload-drift conflicts, terminal immutability, and row/outbox counts. Direct PostgreSQL suite is 11/11. | Passed locally |
| M1H-A05 | HTTP lifecycle invariants | Live REST terminal immutability, completed-zero queryability, missing-run distinction, evidence resolution, and atomic rollback/outbox assertions. | Passed locally |
| M1H-A06 | HTTP security boundary | Scoped auth, pre-mutation schema/body/item/excerpt/metadata/secret limits, Unicode boundaries, rate limiting with `Retry-After`, hostile flags, quarantine, and non-delivery. | Passed locally |
| M1H-A07 | Schema package boundary | Clean `npm ci`, build, and 4/4 tests for publishable `@agent-feed/schema@0.1.1`; nine contracts and runtime/type exports retain protocol `0.1`. | Passed locally |
| M1H-A08 | Immutable artifact candidate | `npm run schema:artifact:test` distinguishes PR/tag/local refs; `npm run schema:artifact -- --tag schema-v0.1.1` creates `agent-feed-schema-0.1.1.tgz` plus a manifest. Local candidate SHA-256: `b6c8c6beb98fea305346f4a23f049deba8498beba84fa643d49c9ecfb8adce75`; integrity: `sha512-Gy3pWM0xNwuGxwXTHx9PH1HmqUwevtToAuXPJQ1JLCScn8+PPJ6atJkO+/2txRAWSRPJ63LlTw3sqSvHLeAxHQ==`. | Candidate passed; immutable release URL/source tag pending merge |
| M1H-A09 | Consumer pin | The release workflow is tag-gated and refuses version/tag drift or asset replacement. A clean external-consumer verification checks the candidate bytes/exports. Rewards must subsequently pin the immutable release URL/version and integrity in its lockfile. | Local consumer proof passed; Rewards pin pending publication |
| M1H-A10 | Full combined gate | Foundation, protocol drift/compatibility, conformance 23/23, prototype 29/29, M1 live ingress 5/5, PostgreSQL 11/11, schema 4/4, producer 9/9, API 2/2, local-file 6/6, and full M2 gate all pass. | Passed locally |
| M1H-A11 | Documentation/reproducibility | This directory, `docs/03_implementation_plan.md`, API/schema/persistence READMEs, operations runbook, and `VALIDATION_REPORT.md` separate current proof from historical baseline. | Passed on PR branch |
| M1H-A12 | Final integrity inventory | `npm run checksums:write` followed by `npm run checksums:check` verifies 237 source-file digests after integration; ignored build/release outputs are excluded so clean-checkout CI sees the same set. | Passed on PR branch |

## Gate decision

The code prerequisite is ready for review. Do not dispatch Rewards Optimizer
Milestone 2.5 until both remaining release actions are evidenced:

1. merge the reviewed Agent Feed PR and create immutable tag `schema-v0.1.1`;
2. record the resulting release asset URL, source commit, SHA-512 integrity,
   and exact non-floating dependency/lockfile entry in Rewards Optimizer.

Prototype and direct-store results remain supporting evidence; only the live
PostgreSQL REST suite counts as durable ingress acceptance.
