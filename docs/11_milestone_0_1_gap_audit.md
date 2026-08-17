# Milestone 0/1 implementation gap audit

Audit baseline: `bbe58bd` (`Add validated run-bundle ingress`), 2026-08-17. This is a read-only audit of the implementation plan, initiating prompt, trust/security/semantic contracts, schemas, examples, reference SQL, prototype, and tests. It does not treat README files or reference SQL as an implemented service.

> Historical baseline: this report intentionally records the pre-integration
> gaps used to plan the six branches. For the merged candidate's current test
> evidence, see `VALIDATION_REPORT.md`.

## Executive verdict

The protocol artifact and zero-dependency prototype are useful and internally testable. Milestone 0 is **partially complete**, not closed: the nine schema files, trust boundary, examples, and prototype exercises exist, but generated Python/types coverage, general semantic enforcement, the redaction-pending invariant, and contract consistency are incomplete. Milestone 1 is **not gate-ready**. There is no PostgreSQL-backed application service or durable REST path; the current HTTP server and importer are explicitly in-memory prototype code.

The baseline can support a prototype rehearsal of the two input shapes, but it cannot start the requested two-lane rehearsal against a shared durable service until the blockers in this report are closed.

## Evidence and validation run

- `prototype/npm run build`: passed.
- `prototype/npm test`: 16/16 passed when loopback binding was permitted. The first sandbox run was 15/16 only because the REST test could not bind `127.0.0.1` (`EPERM`); the same test passed outside that restriction.
- `prototype/npm run demo`: passed.
- `python3 scripts/generate_checksums.py --check`: passed for the 81 baseline files (the report itself is the new file and requires a checksum refresh).
- `/tmp/agent-feed-audit-venv/bin/python scripts/validate_package.py`: passed (9 schemas, selected lifecycle fixtures, zero-finding bundle, hostile fixture, and trust markers). The bare audit shell did not have `jsonschema`/`referencing`; the validator itself still checks selected fixtures, not every semantic invariant or every runtime path.

The checked-in `package-manifest.json:7-10` and `VALIDATION_REPORT.md:15-17` still say there are 8 prototype tests and report 8/8; the actual suite at this baseline has 16 tests. That is a package-integrity/documentation drift, not evidence that the extra tests are absent.

## Requirement-to-code matrix

Status meanings: **complete (artifact)** means the contract/fixture is present; **prototype-only** means demonstrated only by in-memory code; **gap** means the Milestone gate cannot rely on it.

| Requirement | Evidence in baseline | Status / audit finding |
|---|---|---|
| Nine Draft 2020-12 schemas, protocol pinned to `0.1` | `packages/schema/contracts/*.json` (9 files), each with Draft 2020-12 and `const: "0.1"`; exact set checked by `scripts/validate_package.py:21-27` | **Complete (artifact).** Shape is present; semantic relationships are not expressible by these standalone schemas. |
| Generated/inferred TypeScript and Python types | Only `packages/schema/{run-envelope,finding,evidence}.ts`; SDK directories contain README files only | **Gap.** No Python generated types and no types for six schemas. This leaves the cross-language Milestone 0 deliverable incomplete. |
| Trust boundary: finding is a claim, not verified fact | `docs/02_trust_model.md:3-24`; `finding.schema.json` calls authority `source_authority_claim`; validator rejects `verified_fact` text (`scripts/validate_package.py:43-48`) | **Complete (artifact).** Runtime consumers still need to preserve/use this boundary. |
| Evidence is submitted material; refs resolve within a run | Wire checks refs against accumulated bundle evidence (`prototype/src/wire.ts:175-218`); in-memory batch checks refs (`prototype/src/store.ts:70-80`); tests cover missing refs | **Prototype-only / partial.** The schema cannot cross-link objects; SQL `finding_evidence` lacks a same-run composite foreign key, so the reference DB can permit a cross-run link. |
| Completion counts reconcile with accepted rows | Bundle importer checks batch/finding/evidence counts (`prototype/src/wire.ts:221-231`); selected examples are checked by `scripts/validate_package.py:34-42` | **Prototype-only / partial.** Direct `completeRun` has no finding/evidence/batch count inputs (`prototype/src/store.ts:89-105`); Postgres has no reconciliation constraint/trigger. |
| Running/terminal scope and time invariants | Prototype checks completion time and source success ordering (`prototype/src/store.ts:100-104`); SQL trigger checks terminal time (`examples/postgres/0001_reference_schema.sql:98-122`) | **Gap.** No general validator enforces running `actual_scope/completed_at` null or terminal scope non-null; SQL inserts can bypass the update-only trigger. |
| Expected cadence and overdue state independent of producer claims | In-memory expectations/liveness (`prototype/src/store.ts:116-164`); reference SQL sweep/incidents (`examples/postgres/0001_reference_schema.sql:68-198`) | **Prototype-only / partial.** No application-to-Postgres liveness service. In-memory no-run returns `never_seen`; SQL treats `next_due_at is null` as an incident but also returns `never_seen`, while the semantic contract requires an owed no-terminal run to become `overdue`. SQL does not preserve terminal status, `due`, or degraded liveness. |
| Runnable prototype acceptance | `prototype/test`: idempotency, zero findings, refs, liveness, partial, hostile flags, HMAC, bundle import, REST | **Complete as prototype.** It is not persistence or production ingress. The mandatory redaction-pending test is absent. |
| Separate agent-feed database/schema | `examples/postgres/0001_reference_schema.sql` | **Gap.** This is labeled/reference-only DDL; no migration runner, connection, repository, transaction, deployment, or application service exists. SQLite is a four-table demonstration only. |
| Idempotent begin/submit/complete with durable receipts | In-memory maps (`prototype/src/store.ts:18-105`); SQL uniqueness only for begin and batch (`0001_reference_schema.sql:6-28`) | **Prototype-only / blocker.** Receipts disappear on process restart; SQL has no complete idempotency key/hash. In-memory submit hash omits `batch_id` and sequence, and does not enforce unique `batch_id` (`store.ts:52-86`). |
| Atomic immutable findings/evidence and append-only events | In-memory clone/terminal guard; SQL update/delete triggers for runs/batches/findings/evidence (`0001_reference_schema.sql:98-139`) | **Gap.** No transaction service or event writes. SQL has no immutability trigger for `finding_evidence`/outbox payload, no same-run ref FK, and no atomic batch-to-event operation. |
| Producer authentication and stream authorization | Prototype has one static bearer token (`prototype/src/server.ts:48-70`) | **Gap / blocker.** It is not a per-producer credential bound to allowed streams; direct begin/submit/complete and liveness routes have no wire-schema or scope authorization. |
| Body/batch/rate limits, hashes, PII/secret hooks | Body limit and some bundle checks (`prototype/src/server.ts:21-30`, `prototype/src/wire.ts:193-205`); HMAC helper (`prototype/src/security.ts:14-30`) | **Gap / blocker.** No request rate limiter, inbound HMAC integration, key IDs/rotation, PII hook, artifact limit, or durable request hash. Defaults drift: docs require 4,000-character excerpts (`docs/05_security_privacy.md:9-16`), code uses 5,000 (`security.ts:7-11`), schema allows 5,000 (`evidence.schema.json`); schema allows 500 evidence items while docs/code require 100 (`submit-batch.schema.json`, `security.ts:7-11`). |
| REST endpoints and local-file importer | Prototype routes `/import-run-bundle`, `/begin-run`, `/submit-batch`, `/complete-run` (`prototype/src/server.ts:73-93`); local-file entrypoint (`prototype/src/import-file.ts`) | **Prototype-only / partial.** Documented `/v1/runs...` endpoints (`apps/api/README.md:3-13`) do not exist. Direct routes accept camelCase in-memory objects without JSON-schema validation and use no Postgres. |
| Signed event generation | `signBody` helper and finding event helper (`prototype/src/security.ts:14-30`, `prototype/src/store.ts:168-176`) | **Gap / blocker.** No signed outbound event path, key ID, `run.completed` event, outbox enqueue, or durable event receipt. `findingEvents` omits required `attempt` and does not match the wire schema's snake_case payload contract. |
| Hostile flags, quarantine, and terminal redaction invariant | Hostile fixture and flag preservation tests; secret-bearing bundle rejection (`prototype/src/wire.ts:202-205`, `prototype/test/wire.test.ts`) | **Prototype-only / gap.** Flags are retained, but there is no quarantine state/eligibility boundary. No redaction state exists, so “terminal processing cannot remain redaction-pending” is unimplemented and untested. |
| REST/MCP shared service boundary | MCP and REST README claims (`apps/mcp-server/README.md`, `apps/api/README.md`) | **Gap.** Both are documentation; no MCP implementation or shared application service exists. This is intentionally deferred beyond the thin M1 surface, but must not be counted as complete. |

## What is genuinely complete vs prototype-only

Genuinely complete at the contract/artifact layer:

- Nine schema files, protocol `0.1` examples, compatibility/trust documentation, zero-finding and hostile fixtures, and a generic Rewards reference event.
- A strict TypeScript prototype build with bundle-level Ajv validation, evidence-reference/ID/sequence/count checks, payload-drift checks, zero-finding semantics, partial-run scope/error retention, stale-HMAC rejection, and authenticated local HTTP smoke coverage.
- A reference Postgres shape containing core tables, immutability triggers, and a liveness sweep design. It is not an executable persistence implementation.

Prototype-only and therefore not M1-complete:

- All runtime lifecycle, liveness, authentication, REST, local-file, hashing, and event behavior in `prototype/` is process-local. Restart loses runs, idempotency receipts, expectations, and any event state.
- `examples/postgres/*.sql`, SDK/adapters, and `apps/*/README.md` are references/placeholders. There is no repository, transaction boundary, migration/test harness, producer credential store, stream authorization policy, or durable delivery path.
- The current prototype's semantic checks are concentrated in the bundle importer. Direct REST methods bypass the canonical wire schemas, and the in-memory `RunRecord` does not retain full protocol task/producer/errors/count fields.

## Milestone 1 gate blockers

The following are hard blockers, not polish:

1. **Durable service absent.** Implement a Postgres repository/application service and transaction tests. Begin/submit/complete must survive restart, return the original receipt, and atomically write accepted records plus the required event record.
2. **Complete idempotency and immutability incomplete.** Add durable complete keys/hashes, unique batch sequence/IDs, full payload hashes, count reconciliation, same-run evidence references, and immutable accepted/event records. Test direct SQL mutation attempts as well as API retries.
3. **Ingress contract/auth absent.** Implement the documented REST path against the service, validate each request against the canonical schemas, bind producer credentials to streams, and map conflict/auth/size/rate/security errors to the documented classes.
4. **Security defaults are not implemented or aligned.** Add inbound replay/authentication, explicit key IDs/rotation, 60/minute plus burst-10 limiting, 1 MiB body and 100/100 batch limits, 4,000 UTF-8 excerpt and 64 KiB inline metadata checks, PII/secret hooks, and durable payload hashes. Resolve the schema/code limit drift before conformance is frozen.
5. **Events are not a usable contract.** Persist append-only run/finding events, generate `run.completed`/partial/failed events after accepted rows, include event ID/attempt/protocol version, sign `timestamp.raw_body`, and test stale/replayed signatures. Full queue delivery remains Milestone 2; M1 still needs signed event generation and durable enqueue semantics.
6. **Liveness is not durable or semantically aligned.** Persist consumer-owned expectations, terminal status, due/overdue state, missed-run incidents, recovery resolution, and a scheduled sweep. Prove absent-run versus completed-zero and partial/failed degradation without trusting producer schedule metadata.
7. **Quarantine/redaction is absent.** Retain hostile flags, mark the record quarantined before consumer eligibility, and make terminal transition reject or resolve any pending redaction. Add the mandatory test.
8. **Milestone 0 type/conformance drift remains.** Add generated/inferred coverage for all schemas (including Python boundary or explicitly defer it), update semantic validation beyond fixtures, and refresh `package-manifest.json`/`VALIDATION_REPORT.md` test counts.

## Parallel branch dependency and merge order

All five branches started from `bbe58bd`; use this order when integrating them:

1. **`agent/m0-types` first.** Freeze the generated/inferred type names, canonical serializer/hash inputs, protocol error taxonomy, and shared service interfaces. Do not let later branches invent parallel camelCase/wire types.
2. **`agent/m1-postgres` next, with `agent/m1-security` developed in parallel after the type interface is agreed.** Postgres owns migrations, constraints, transaction/repository behavior, and durable idempotency. Security owns credential/scope checks, canonical raw-body HMAC/replay, limits, and quarantine hooks. Security must target the repository/service boundary, not duplicate storage logic.
3. **`agent/m1-liveness` after the Postgres contract is fixed.** It needs stream-expectation/incident tables and terminal transition hooks; its event shape must be agreed with security before writing signed payloads. Keep liveness sweep and event generation in separate modules even if they share the terminal-transition transaction.
4. **`agent/m1-conformance` last.** Run the full schema/example/runtime/SQL/security/liveness matrix against the merged service, close the known contract drifts, update manifest/validation evidence, regenerate checksums, and make the gate decision. Conformance should not redefine the shared types or SQL schema.

Recommended graph: `types → (postgres ∥ security) → liveness/events → conformance`. If security needs the concrete repository before it can land, merge `postgres` first but keep the two branches rebased on the type commit.

Conflict hotspots to resolve deliberately:

- `prototype/src/types.ts`, `store.ts`, `wire.ts`, and `server.ts`: types, security, liveness/events, and conformance will all otherwise edit the same prototype boundary.
- `packages/schema/contracts/*`, `packages/schema/*.ts`, and `docs/09_api_and_mcp_contract.md`: type/event/error shape must have one owner before tests are written.
- `examples/postgres/0001_reference_schema.sql` and `001_liveness_and_immutability.sql`: Postgres and liveness/events will touch triggers, terminal transitions, and incident semantics.
- `prototype/test/*.test.ts`, `scripts/validate_package.py`, `package-manifest.json`, `VALIDATION_REPORT.md`, and `SHA256SUMS.txt`: conformance owns the final test count/checksum refresh; do not hand-edit checksums in other branches.
- `docs/03_implementation_plan.md`, `docs/05_security_privacy.md`, and `docs/10_semantic_invariants.md`: resolve requirement changes as contract decisions, not incidental implementation edits.

## Deferred Milestone 2+ scope

Do not pull these into the M1 gate:

- **Milestone 2:** transactional outbox workers/queues, consumer subscriptions, signed webhook delivery, pull cursors, retries/backoff, dead-letter/replay/acknowledgement, and delivery metrics. M1 only needs durable event creation/signing; external delivery remains at-least-once and queue-backed in M2.
- **Milestone 3:** production MCP, TypeScript/Python SDK packages, Claude hook, generic webhook and broad adapters, polished deployment, and capability-gated Scheduled Task export. The local-file importer is the thin M1 fallback.
- **Milestone 4:** Rewards domain implementation, canonical evidence capture, reward-rule promotion, and semantic dedupe. Keep only the generic reference event; no direct database access or automatic evidence promotion.
- **Milestone 5:** separate production Supabase, SQLite/portability hardening, retention/deletion jobs, audit export, cost/backlog metrics, and admin/Realtime dashboards. Realtime must never become the queue.

## Exact two-lane rehearsal readiness criteria

Interpret the two lanes as (A) a tool/API-capable producer and (B) ChatGPT/manual run-bundle fallback. MCP is a later adapter; both lanes must converge on the same application service and database boundary. The rehearsal is **READY only if every item below passes in one clean, resettable Postgres environment**; otherwise it is **NOT READY**.

1. **Shared contract:** protocol `0.1`; all nine schemas, every checked-in example, generated types, and semantic conformance tests pass. The same run ID, stream ID, finding/evidence IDs, and counts are visible on both lanes.
2. **Lane A ingress:** a producer credential can begin, submit at least one bounded batch, and complete through the documented REST path; a credential for another stream is rejected. Requests are schema-validated before mutation.
3. **Lane B import:** a single JSON run bundle from the ChatGPT fallback imports through the local-file path, produces the same canonical run/finding/evidence state, and can be retried after a process restart.
4. **Durable retries:** for begin, batch, bundle import, and complete, an exact retry returns the original receipt with no new rows/events; changing any payload under the same idempotency key returns protocol conflict (HTTP 409 for REST). Completing again cannot alter terminal state.
5. **Atomic/immutable storage:** a batch with findings and submitted evidence commits atomically with its event record; forced failure leaves no partial accepted rows. Direct updates/deletes of terminal runs, batches, findings, evidence, refs, and accepted event payloads fail.
6. **Lifecycle semantics:** demonstrate completed-zero (queryable and healthy), partial (actual scope and errors preserved/degraded), failed/cancelled (terminal and queryable), and absent run (not synthesized as zero findings).
7. **Liveness:** register cadence/grace outside producer payloads; after the due window an absent terminal run is `overdue` and opens one missed-run incident; a terminal run of any status proves execution; a recovered stream resolves but does not delete the incident.
8. **Security envelope:** enforce 1 MiB body, 100 findings/100 evidence, 4,000 UTF-8 excerpt, 64 KiB inline metadata, and 60/minute with burst-10; verify HMAC replay rejection at >300 seconds and accepted raw-body signatures with key IDs. No secret/PII test fixture reaches consumer eligibility.
9. **Hostile/quarantine:** import the hostile fixture, retain its security flags and original untrusted content, set quarantine/non-delivery state, and prove it cannot become a verified fact or consumer-domain rule. Terminal processing has no pending redaction.
10. **Signed event evidence:** each accepted finding and terminal transition has a durable event ID, protocol version, attempt, run/stream IDs, and valid HMAC over the exact raw body; event generation is append-only and does not depend on Realtime.
11. **Consumer boundary:** the generic Rewards reference consumer receives an untrusted observation only; transport dedupe and domain semantic dedupe are separate, submitted evidence is not promoted automatically, and no consumer reads Agent Feed tables.
12. **Reproducibility:** one documented command sequence resets the database, runs both lanes plus all fixtures/tests, verifies checksums, and emits receipts, row counts, liveness incidents, signature results, and quarantine results suitable for review. Scheduled Task silence is treated as an overdue incident, never as healthy monitoring.

On the audited baseline, criteria 1 (partially), 6 (prototype-only), and selected fixture portions pass; criteria 2-5 and 7-12 are not yet demonstrated against a durable service. The two-lane rehearsal must therefore remain **NOT READY**.
