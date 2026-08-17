# Milestone 1 corrective-hardening decisions

Status: **implemented; release evidence pending** (2026-08-18)

This record covers the narrowly scoped repair required before the Agent Feed
project can be consumed by the Rewards Optimizer. It does not reopen the M2
delivery design or authorize Rewards-domain implementation. Decisions and
status updates are append-only; when an implementation lands, add evidence
and a dated resolution note instead of rewriting the original decision.

## Evidence baseline

The merged baseline (`c52cf9a`, the PR #2 merge) establishes the following:

- `apps/api/README.md` documents the producer route shape but explicitly says
  that no executable handlers are present;
- `prototype/src/server.ts` is the runnable producer HTTP path and constructs
  an in-memory `AgentFeedStore` by default;
- `packages/persistence-postgres` contains a durable lifecycle service and
  direct persistence tests, but no HTTP composition root connects it to the
  documented producer routes;
- `packages/schema` contains checked-in contracts and TypeScript helpers, but
  not a publishable `@agent-feed/schema` package manifest, exports, or release
  artifact at the baseline commit;
- the Rewards integration prompt requires REST ingress and a pinned published
  protocol artifact before Milestone 2.5.

The shared worktree may contain uncommitted corrective implementation files.
Those files are not release evidence until their clean build, tests, artifact
digest, and combined gate are recorded.

## D-001 — Treat durable REST as a Milestone 1 release prerequisite

The documented M1 routes must execute through an application service backed by
the PostgreSQL persistence boundary. A prototype route backed by process-local
maps is useful development evidence only. The corrective gate therefore
requires a live HTTP test that starts the API, points it at a disposable
PostgreSQL database, exercises begin/submit/complete and read paths, restarts
the API, and verifies that state and idempotency receipts remain available.

The API layer may perform transport concerns (authentication, schema validation,
limits, error mapping, and request context), but it must not issue direct SQL or
reimplement persistence semantics.

## D-002 — Keep protocol version and package version independent

Wire compatibility remains protocol `0.1`. A publishable package has its own
immutable package version; the corrective release candidate is currently
`@agent-feed/schema@0.1.1`, but that identity is not accepted until the
artifact is built and verified.

The package must expose the checked-in JSON contracts and generated/runtime
helpers through a public `@agent-feed/schema` export boundary. Handwritten
duplicate contracts are not acceptable.

## D-003 — Require an immutable schema artifact pin

Rewards Optimizer consumption is gated on all of the following being recorded:

1. package name and exact version;
2. immutable registry tarball or release-asset URL/reference;
3. SHA-512 integrity value computed from the exact artifact bytes;
4. source commit that produced the artifact; and
5. a clean consumer install or package-manager lock entry using that exact pin.

Floating ranges (`^`, `~`, `latest`), branches, mutable URLs, workspace links,
and `file:` dependencies are not artifact-pin evidence. A local `npm pack`
without recording and independently verifying its digest is only a build
smoke test.

## D-004 — Separate historical evidence from the corrective gate

The original 23/23 conformance and prototype REST smoke results remain useful
contract evidence. They do not satisfy the new gate because their public HTTP
surface is the in-memory prototype. Direct PostgreSQL persistence tests prove
the adapter but do not prove HTTP composition. The corrective acceptance record
must identify the command, database mode, commit, test counts, and any skipped
test explicitly; a live-PostgreSQL skip is never green acceptance.

## D-005 — Preserve M2 status while blocking downstream release

M2's durable delivery implementation remains complete for the scope and
evidence recorded in `docs/12_milestone_2_delivery.md`. That status is not a
claim that producer REST is deployed. The unresolved M1 prerequisite blocks the
overall Agent Feed release and the Rewards Optimizer Milestone 2.5 dispatch,
but does not require reverting or redesigning M2 delivery work.

## D-006 — Generate repository checksums last

`SHA256SUMS.txt` and any package manifest counts are final integration outputs.
Do not regenerate or hand-edit them while API/schema implementations are still
changing. The final conformance owner must regenerate them once the corrective
implementation, tests, release artifact, and documentation have landed, then
run the checksum check as part of the combined gate.

## D-007 — Separate wire IDs from relational IDs

Protocol `run_id` remains an arbitrary string. PostgreSQL keeps UUID primary
and foreign keys for relational integrity while migration `0003_wire_run_id.sql`
adds a tenant-scoped, immutable `wire_run_id` used at every producer/delivery
boundary. Adapters must never rewrite a producer-visible ID to satisfy a
storage implementation detail.

## D-008 — Put producer policy in one application service

REST and local-file adapters call `@agent-feed/producer-service`. The service
owns authentication context, stream scope, validation, size/cardinality/rate
limits, secret/PII/quarantine policy, and error mapping. PostgreSQL owns
transactions and storage invariants. HTTP handlers own only transport parsing
and response mapping. A static architecture check prevents prototype imports,
database drivers/SQL in those boundaries, and Rewards-domain coupling.

## D-009 — Publish schema as immutable GitHub release assets

The first schema distribution uses the exact package version
`@agent-feed/schema@0.1.1` and a `schema-v0.1.1` tag. The tag-gated workflow
builds from tagged source, verifies the package, records SHA-256/SHA-512, and
creates a release asset without overwrite. This avoids pretending an npm
registry release exists while still giving Rewards an immutable, integrity-
pinned artifact. The source commit is the tagged commit.
