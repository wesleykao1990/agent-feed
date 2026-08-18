# Milestone 1 corrective-hardening acceptance matrix

Status: **AGENT FEED IMPLEMENTATION AND SCHEMA RELEASE GATES GREEN** (2026-08-18)

This matrix is the release gate for durable producer REST ingress and the
schema artifact. A live PostgreSQL skip is not a pass. The branch has passed
the implementation checks below; publication of the tag-gated artifact and
the downstream Rewards Optimizer lockfile pin remains independently tracked in
that separate repository.

| ID | Acceptance area | Evidence | Status |
|---|---|---|---|
| M1H-A01 | Executable API boundary | `npm run m1:architecture`; clean build/test of `packages/producer-service` and `apps/api` (9/9 and 2/2). The producer package owns an adapter-neutral persistence port; handlers compose the PostgreSQL implementation only in the executable API. | Passed locally |
| M1H-A02 | PostgreSQL composition | `AGENT_FEED_DATABASE_URL=... npm run m1:ingress` exercises the public REST entrypoint and ChatGPT scheduled-output adapter through migrations `0001`–`0003`. | Passed locally, 6/6 |
| M1H-A03 | Durable restart | The live REST suite stops its first server, launches `apps/api/src/main.ts` in a new OS process with a fresh pool, reruns startup migrations/environment credential composition, reads the same completed run/findings, and exercises SIGTERM cleanup. | Passed locally |
| M1H-A04 | HTTP idempotency/conflict | Live REST exact begin/batch/complete retry receipts, payload-drift conflicts, terminal immutability, and row/outbox counts. Direct PostgreSQL suite is 11/11. | Passed locally |
| M1H-A05 | HTTP lifecycle invariants | Live REST terminal immutability, completed-zero queryability, missing-run distinction, evidence resolution, and atomic rollback/outbox assertions. | Passed locally |
| M1H-A06 | HTTP security boundary | Scoped auth, pre-mutation schema/body/item/excerpt/metadata/secret limits, Unicode boundaries, rate limiting with `Retry-After`, hostile flags, quarantine, and non-delivery. | Passed locally |
| M1H-A07 | Schema package boundary | Clean `npm ci`, build, and 4/4 tests for publishable `@agent-feed/schema@0.1.1`; nine contracts and runtime/type exports retain protocol `0.1`. | Passed locally |
| M1H-A08 | Immutable artifact | Tag `schema-v0.1.1` published `agent-feed-schema-0.1.1.tgz` (13,078 bytes) from commit `ad7e1a7270d0ebc09ffdc844d38cfa71a87bf95e`; SHA-256 `9e020aba4e291f2e5328897dfb07195aaf392f6ecdd742b5c13b890cffdd9d6e`; integrity `sha512-KHALcE3zQ/dey5GTXepDeXaz77Qf1DP3ySA+rcbG6eiFvUTws21cry8rfM191wyLeQthJ9ENd0neu23ETwX5/g==`. | Passed and published |
| M1H-A09 | Consumer pin boundary | The immutable asset URL is `https://github.com/wesleykao1990/agent-feed/releases/download/schema-v0.1.1/agent-feed-schema-0.1.1.tgz`. Agent Feed records the exact bytes and integrity; the Rewards lockfile state is owned and accepted in its separate repository. | Agent Feed release evidence passed; downstream state out of scope |
| M1H-A10 | Full combined gate | Foundation, protocol drift/compatibility, conformance 23/23, prototype 29/29, current M1 live ingress 6/6, PostgreSQL 11/11, schema 4/4, producer 9/9, API 2/2, local-file 10/10, and full M2 gate all pass. Hosted run `32056120146` passed the predecessor 5/5 ingress set on source commit `b217470552d668d6694edfa7e28b15b3279a73f5`; the added ChatGPT regression is locally green pending the current branch's hosted run. | Passed locally; prior hosted baseline passed |
| M1H-A11 | Documentation/reproducibility | This directory, `docs/03_implementation_plan.md`, API/schema/persistence READMEs, operations runbook, and `VALIDATION_REPORT.md` separate current proof from historical baseline. | Passed on PR branch |
| M1H-A12 | Final integrity inventory | `npm run checksums:write` followed by `npm run checksums:check` currently verifies 340 source-file digests; ignored build/release outputs are excluded so clean-checkout CI sees the same set. Hosted run `32056120146` verified its earlier 237-file inventory. | Passed locally; prior hosted baseline passed |

## Gate decision

The Agent Feed code and immutable schema release prerequisites are complete.
The separate Rewards Optimizer must independently record and accept its exact
non-floating dependency and lockfile entry; this repository does not claim or
modify that downstream state.

Prototype and direct-store results remain supporting evidence; only the live
PostgreSQL REST suite counts as durable ingress acceptance.
