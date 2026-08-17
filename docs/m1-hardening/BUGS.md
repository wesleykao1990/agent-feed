# Milestone 1 corrective-hardening bug and gap log

Status: **implementation gaps resolved; release/pin evidence pending** (2026-08-18)

This is an append-only log. Do not silently rewrite an observation when a fix
lands. Add a dated resolution row or note with the implementation commit,
regression test, and validation command. “Prototype-only” and “direct-store”
evidence do not close a durable REST item.

| ID | Symptom / evidence | Impact | Planned fix | Regression evidence required | Status |
|---|---|---|---|---|---|
| M1H-001 | `apps/api/README.md` says no executable handlers are present; the runnable `prototype/src/server.ts` constructs an in-memory `AgentFeedStore`. | The documented producer REST path does not provide durable ingress and loses state on process restart. | Implement the producer HTTP composition root against the shared application service and `PostgresAgentFeedPersistence`; keep SQL out of the transport layer. | Live HTTP begin/submit/complete/read test against disposable PostgreSQL, followed by API restart and durable read/retry assertions. | Open — API implementation pending |
| M1H-002 | The prior `VALIDATION_REPORT.md` called the integrated M0/1 candidate passed and listed REST smoke flows, although those flows exercised the prototype path. | A reviewer can mistake prototype acceptance for the Milestone 1 durable REST gate. | Correct the validation report and implementation plan; link the corrective acceptance matrix and preserve the historical result as qualified evidence. | Documentation review confirms no current M1 pass is claimed until the live REST suite and artifact pin are recorded. | Resolved by documentation correction in this worktree |
| M1H-003 | At the merged baseline, `packages/schema` had checked-in contracts and helper files but no `package.json`, public package exports, build/test boundary, or publishable artifact. | Rewards Optimizer could not pin and verify the protocol contract as an immutable dependency. | Add the `@agent-feed/schema` package boundary, package metadata, exports, generated/runtime artifact inventory, and release procedure without changing wire protocol `0.1`. | Clean package build/test, `npm pack` inventory, exact artifact digest, and consumer install from the recorded immutable artifact. | Open — corrective schema files are uncommitted/unverified |
| M1H-004 | PostgreSQL tests call `PostgresAgentFeedPersistence` directly; there is no committed test proving the HTTP adapter composes with it. | Authentication, schema validation, error mapping, limits, idempotency, and storage behavior may drift at the transport boundary. | Add an end-to-end REST acceptance harness with a disposable PostgreSQL database and authenticated producer credentials. | Exact retry, payload conflict, authorization, body/batch limits, terminal immutability, zero findings, and hostile input through HTTP. | Open — REST acceptance harness pending |
| M1H-005 | The Rewards integration prompt requires a pinned published protocol artifact, but the merged baseline contains only source contracts and no immutable consumer pin. | Milestone 2.5 could compile against an unreviewed or mutable schema source. | Release the schema artifact and record exact version, immutable URL/reference, SHA-512 integrity, source commit, and consumer lock entry. | Clean consumer install resolves the recorded bytes; altered bytes or a different version fail the integrity check. | Open — release evidence pending |
| M1H-006 | Existing gate commands validate protocol/prototype and M2 packages, but no combined gate starts producer REST against PostgreSQL and checks the schema artifact. | Green CI can still leave the stated Milestone 1 prerequisite absent. | Extend the corrective gate and CI/workflow evidence after API and schema implementations land; do not count live-test skips. | One documented resettable command sequence emits test counts, live DB URL mode, artifact digest, and checksum result. | Open — gate integration pending |

## Resolution notes

The table above preserves the baseline observations. Resolutions recorded on
2026-08-18:

| ID | Resolution | Regression evidence | Current state |
|---|---|---|---|
| M1H-001 | Added executable `apps/api` backed by `PostgresAgentFeedPersistence` through `ProducerService`; the request handler imports neither SQL nor the prototype. | Producer architecture check, API 2/2, live ingress 5/5 including restart. | Resolved in PR branch |
| M1H-003 | Added publishable `@agent-feed/schema@0.1.1`, public exports for all nine schemas/types, clean build/tests, deterministic pack manifest, and tag-gated release workflow. | Schema 4/4, artifact build and clean external-consumer verification. | Implementation resolved; immutable tag/URL pending merge |
| M1H-004 | Added fail-closed live HTTP and local-file acceptance against disposable PostgreSQL. | `AGENT_FEED_DATABASE_URL=... npm run m1:ingress` passes 5/5 without skips. | Resolved in PR branch |
| M1H-005 | Added exact-version artifact production and integrity verification. | Candidate SHA-256/SHA-512 in acceptance report; release workflow rejects tag/version mismatch and replacement. | Release asset and Rewards lockfile pin pending |
| M1H-006 | CI now clean-installs/builds/tests all corrective packages, builds/verifies the artifact, and runs live ingress before M2. | Full local combined gate is green; hosted run `32056120146` passed on commit `b217470552d668d6694edfa7e28b15b3279a73f5`. | Resolved in PR branch |

## Bugs encountered during implementation

| ID | Observation | Resolution and retained test |
|---|---|---|
| M1H-007 | Protocol run IDs are arbitrary strings, while the original relational key was UUID-only. Durable local-file imports could not preserve wire identity. | Migration `0003_wire_run_id.sql` separates tenant-scoped immutable `wire_run_id` from the internal UUID key. Live local-file and persistence tests use non-UUID IDs. |
| M1H-008 | An exact begin retry after terminal completion could return the current terminal envelope rather than the original begin receipt. | The adapter reads the immutable `run.started` outbox payload for the original begin result. Persistence regression covers post-terminal retry. |
| M1H-009 | Default burst limiting masked lifecycle assertions because the conformance flow intentionally makes many rapid requests. | Lifecycle tests inject a high deterministic limit; a separate focused case proves 429 and `Retry-After`. Production defaults are unchanged. |
| M1H-010 | UTF-16 `.length` counted astral Unicode characters twice, rejecting valid 4,000-code-point evidence excerpts. | Schema normalization and security checks use Unicode code-point counts; 4,000/4,001 boundary tests assert acceptance/rejection and zero mutation. |
| M1H-011 | Referenced evidence with secrets/personal-data/restricted/malformed handling could leave the finding event consumer-eligible. | Persistence marks the finding outbox event quarantined/non-deliverable whenever referenced evidence requires quarantine; live regression proves no fan-out. |
| M1H-012 | A nested `npm pack` test could write to a developer-global npm cache and fail in isolated environments. | Artifact builds use a per-run temporary npm cache and remove it on completion. |
| M1H-013 | A child-test runner that only set `process.exitCode` could be reported as successful by the orchestration environment after a child failure. | Both M1 runners now terminate with the child non-zero status; fail-closed behavior is retained. |
| M1H-014 | Root checksum/foundation scripts invoked `python`, which is absent on otherwise valid Python 3-only developer systems. A multi-command shell could then hide the failure behind a later successful command. | Root npm scripts now invoke `python3`; CI still provisions Python 3 explicitly. Final checksum write/check is executed as its own fail-fast gate. |
| M1H-015 | The checksum inventory included ignored `dist/`, `.build-src/`, and `artifacts/` outputs, so a developer checkout after building did not describe the clean checkout CI validates. | The generator excludes those reproducible/ignored directories; the final inventory is regenerated from tracked source and checked before builds in CI. |
| M1H-016 | The first restart fixture recreated a server in the same Node process and reused its pool, so it did not prove the executable composition root. | The live fixture now launches `apps/api/src/main.ts` as a child OS process with environment credentials and a fresh pool, reruns migrations, reads durable state, and shuts down via SIGTERM. |
| M1H-017 | Producer and stream `*` values created an undocumented cross-producer authorization mode. | `StaticProducerAuthenticator` rejects wildcard producer/stream credentials at startup; exact-scope assertions remain in unit and live REST tests. |
| M1H-018 | Migration `0003` ran but was absent from `agent_feed.schema_migrations`, contradicting the operations runbook. | `0003` records the foundation and wire-ID versions; the live persistence suite asserts the exact `0001`/`0002`/`0003` ledger. |
| M1H-019 | POST routes accepted JSON bytes without requiring the JSON media type and could reject a declared oversize body without draining it. | The HTTP adapter requires `application/json`, returns 415 before mutation, and drains rejected/oversize request streams. |
| M1H-020 | Hosted CI's clean producer build followed a source-linked `@agent-feed/persistence-postgres` dependency and failed on the adapter's undeclared build context, although a populated local checkout passed. | The producer service now owns an adapter-neutral `ProducerPersistence` port and lifecycle record types. Its source, manifest, and downstream lock entry have no PostgreSQL dependency; the architecture gate enforces exact/subpath imports plus manifest/lock boundaries. Recognized adapter failures cross only as an allowlisted code/status with messages and details sanitized; unknown failures collapse to `storage_error`. The API remains the explicit composition root and installs the durable adapter dependency graph before its build. |
| M1H-021 | GitHub sets `GITHUB_REF_NAME` to values such as `3/merge` for pull-request runs, and the artifact builder treated every ref name as a release tag. | Candidate builds now infer a tag only when `GITHUB_REF_TYPE=tag`; the tag release workflow still passes `--tag` explicitly. A focused environment regression covers PR, tag, and local contexts. |

Hosted CI run `32056120146` passed every configured gate after M1H-020 and
M1H-021 on source commit `b217470552d668d6694edfa7e28b15b3279a73f5`.

The independent 2026-08-18 re-audit verified M1H-015 through M1H-019. M1H-020
was found by the first hosted PR run and corrected without weakening the
boundary. Immutable release publication and the Rewards dependency pin remain
sequenced post-merge actions, not hidden implementation exceptions.
