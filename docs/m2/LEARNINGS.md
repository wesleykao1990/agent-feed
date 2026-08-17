# Milestone 2 engineering learnings

Status: **initial observations; append-only**

These entries capture implementation rules derived from the current repository
and the M2 design. Add new entries instead of replacing earlier observations.

The initial timestamp/tie-breaker observation in M2-L009 is refined by
M2-L013: the final multi-stream cursor coordinate is tenant-global monotonic
position, with event ID retained only as a deterministic tie-breaker where
needed.

| ID | Observation/evidence | Learning | Action |
|---|---|---|---|
| M2-L001 | Delivery is multi-consumer, but M1's outbox placeholder has a single `delivered_at`. | Outbox existence and delivery completion are different facts. Delivery state must be per subscription and event. | Use `(subscription_id,event_id)` as the acknowledgement identity; test independent consumer outcomes. |
| M2-L002 | M1 accepted rows are transactional, but no event rows are written by the ingress service. | A durable outbox is only reliable when it shares the ingress transaction; a post-commit enqueue has a loss window. | Pass a transaction-aware outbox writer into batch/complete application flow. |
| M2-L003 | The protocol schema is strict and snake_case; prototype helpers are camelCase. | Sign exactly the schema-defined wire bytes, not an internal object representation. | Centralize wire conversion and validate the exact signed raw body. |
| M2-L004 | Canonical JSON code is duplicated in three modules. | Small serialization differences become protocol and idempotency bugs. | Extract one runtime canonicalizer; add a cross-package parity test. |
| M2-L005 | The current PostgreSQL loader names one migration file explicitly. | Adding a second migration requires an ordered migration contract, not a second ad-hoc URL. | Implement discovery/order/idempotence tests before operating M2 against a real database. |
| M2-L006 | M1 uses `FOR UPDATE` on run rows for idempotent batch ordering. | Database locking is already the persistence concurrency boundary; M2 can use the same database with `SKIP LOCKED` for worker claims. | Keep queue claims in a repository adapter and test concurrent workers plus lease expiry. |
| M2-L007 | HTTP acknowledgement can be lost after a consumer commits its receipt. | Exactly-once external delivery cannot be promised; at-least-once plus consumer idempotency is the honest contract. | Preserve event ID across retry/replay and require durable consumer receipts before `2xx`. |
| M2-L008 | `DeliveryEvent` already contains `event_id` and `attempt`. | A new protocol body field is not necessary for basic attempt lineage. | Keep trace/attempt state out of the protocol body unless a versioned decision requires it. |
| M2-L009 | Pull pagination can see multiple events with identical timestamps. | Timestamp-only cursors skip or repeat events. | Use an opaque `(created_at,event_id)` cursor scoped to the consumer/subscription. |
| M2-L010 | Prototype, API README, and Supabase docs describe future behavior while executable code is intentionally thin. | Documentation status must distinguish design/reference from implemented behavior. | Every M2 feature gets implementation status, executable evidence, and a validation-report entry before being marked complete. |
| M2-L011 | Checksums cover every tracked file except ignored build/dependency paths. | Documentation and generated artifacts are part of the package integrity contract. | Regenerate `SHA256SUMS.txt` only after code, docs, manifests, and tests settle. |

## Follow-up learnings — 2026-08-18

| ID | Observation/evidence | Learning | Action/status |
|---|---|---|---|
| M2-L012 | Core and consumer selectors originally accepted different wildcard, event-type, and routing-tag shapes. The consumer matcher now delegates to core, but normalization and package-boundary parity are not yet tested together. | A shared type name is not enough; selector normalization, matching fixtures, and dependency direction must be one contract. | Add cross-package parity fixtures and keep the consumer application above delivery-core. Partial/open. |
| M2-L013 | A cursor over a union of streams cannot be correct if each stream has an independent position: one stream can advance past unseen events from another stream between page requests. | Multi-stream pull requires one tenant-global monotonic delivery position (the legacy `stream_position` name may remain for compatibility), not a per-stream cursor coordinate. | Allocate globally, bind activation/cursor to that position, and test concurrent multi-stream pagination. Decision frozen; implementation open. |
| M2-L014 | A bounded in-memory metrics sink is useful in unit tests, while the `MetricsSink` port and deployment exporter can still accept arbitrary names/labels. | Test-time cardinality limits do not establish a production observability contract. | Define allowlisted metric names/keys/values in the worker/exporter adapter and test overflow/redaction. Partial/open. |
| M2-L015 | Each new package can pass its local build and test while root scripts and CI omit it, and individual lockfiles do not prove a clean repository install. | Package modularity needs repository-level build/test/lockfile parity as an explicit gate. | Wire root/CI checks and add a clean-build validation report before M2 approval. Open. |
| M2-L016 | Protocol `0.1` requires `attempt` inside the signed event body, so retries necessarily alter raw body/signature even when source identity is stable. | Retry raw bytes cannot be frozen independently of attempt; this is compatibility debt, not permission to add undocumented fields. | Keep event ID/payload/time/hash immutable, re-encode/re-sign each attempt, and add retry/replay integration evidence. Frozen/partial. |
| M2-L017 | A repository and outbox writer can be implemented and compile while all PostgreSQL conformance tests remain skipped without a database. | Code presence is not durability evidence; transaction, lease, scope, and replay claims require live database tests. | Keep structural/unit results separate from live acceptance and fail the M2 gate on missing database coverage. Open. |
| M2-L018 | TypeScript package-name imports can still bypass a package's public boundary through `@agent-feed/delivery-core/src/*`, and a local lockfile can hide missing declared exports. | Modularity requires declared dependencies plus public export maps, not merely a non-relative import spelling. | Add an import/export audit and clean-install check; remove source subpath imports. Open. |
| M2-L019 | A stale conformance test can say a repository is absent after the repository foundation lands. | Test fixtures and skip reasons are part of the implementation contract and must be updated in the same pass as code. | Reconcile conformance skip text, package status docs, and live test gates before approval. Open. |
| M2-L020 | A package can have a lockfile and package manifest while an empty local `node_modules` makes its test/build commands fail to resolve file dependencies and `tsc`. | Dependency installation is part of the modularity acceptance test; individual source/build evidence from another checkout cannot stand in for a clean install. | Run clean installs from each owned package and repository CI, then verify API/package-name exports. Open. |
| M2-L021 | A tested worker composition root can recover/claim through injected ports without being a deployable process. | Process lifecycle code and production deployment/connection evidence are separate gates. | Keep composition pure and add an explicit process entrypoint plus live repository/webhook tests. Partial/open. |

### Follow-up amendment — 2026-08-18

M2-L020 was observed when the API package had an empty `node_modules`. The
package links were subsequently installed in the shared workspace and the
current `apps/delivery-api` run passes 3/3 tests plus `npm run build`. The
learning remains active: a local repaired install is not clean-install or CI
evidence, so dependency resolution must remain an explicit M2 acceptance gate.

The current conformance harness also removed the stale repository-absence
fixture: it now passes 6/6 pure tests, while the separate PostgreSQL suite
continues to skip live cases without a database URL. This preserves the
distinction between pure behavior evidence and durable acceptance evidence.

| ID | Observation/evidence | Learning | Action/status |
|---|---|---|---|
| M2-L022 | A cursor token may look opaque while still being only base64 JSON. | Pull cursors need runtime-owned canonicalization, signature verification, expiry, and scope checks at the adapter boundary; framing alone is not authentication. | Use `BoundCursorCodec`; retain tamper/scope/expiry tests and run the live repository fixture. Partial/pending combined tests. |
| M2-L023 | Idempotency keys are reused by independent tenants and must not collide across tenant boundaries. | Tenant scope belongs in database uniqueness and conflict lookup predicates, not only in application authorization. | Keep tenant-prefixed uniqueness and cross-tenant regression coverage. Partial/pending live migration evidence. |
| M2-L024 | A finding's evidence references are useful for relational links, but an event containing only IDs is insufficient for a downstream consumer that receives the finding event. | Build the event payload at the transaction boundary from the full submitted-evidence map while preserving the untrusted/evidence distinction. | Assert full evidence payload delivery and preserve source IDs separately. Partial/pending live outbox evidence. |
| M2-L025 | Idempotent insert conflict handling can hide changed immutable event content when it only ignores a duplicate key. | Exact retry and immutable drift are different outcomes: compare the existing row under lock and reject drift explicitly. | Use `outbox_event_idempotency_conflict` and test changed event content under one key. Partial/pending live evidence. |
| M2-L026 | Package-name syntax alone does not guarantee a public package boundary; `/src/*` subpaths can bypass exports. | Modular installs require declared dependencies, explicit exports, and a source-subpath audit in addition to local TypeScript success. | Keep package-name imports and run clean-install/combined boundary checks. Partial/pending combined tests. |

The M2-L013 tenant-global multi-stream cursor decision is now represented in
the migration/repository foundation through `delivery_position` and the
tenant counter; the earlier pending proof was combined/live concurrency
pagination, activation, and no-duplicate/no-skip behavior. The closure index
below records that evidence as green.

## M2 implementation-gate closure — 2026-08-18

The earlier append-only rows record discovery states. The current closure
status is based on the green combined acceptance: architecture 4, pure 6,
live PostgreSQL 3, protocol 5, core 11, consumer 8, persistence 9, webhook 7,
worker 4, API 3, plus clean installs/builds/tests for all seven M2
packages/applications.

| Learning | Current status |
|---|---|
| M2-L005 migration ordering | Resolved for M2 by the explicit `0001` → `0002` loader; arbitrary future directory discovery remains nonblocking operational work. |
| M2-L009/M2-L013 cursor ordering | Resolved by tenant-global `delivery_position` and live multi-stream/scope-bound cursor acceptance. |
| M2-L012 selector parity | Resolved by delivery-core ownership, consumer delegation, and combined selector tests. |
| M2-L014 metrics bounds | Resolved for the M2 contract; production exporter/deployment remains future work. |
| M2-L015/M2-L020 install and CI parity | Resolved in repository configuration: all seven clean installs/builds/tests pass and the workflow requires PostgreSQL; no hosted GitHub run is claimed. |
| M2-L016 attempt compatibility | Resolved by protocol 0.1 body-level attempt tests and live retry/replay evidence. |
| M2-L017 durable evidence | Resolved by the 3/3 live PostgreSQL suite. |
| M2-L018/M2-L026 package boundaries | Resolved by public exports, declared dependencies, static checks, and clean installs; retain regression guards. |
| M2-L019 stale conformance fixture | Resolved; the current pure harness is 6/6 and live PostgreSQL cases are 3/3 with the database configured. |
| M2-L021 worker process distinction | Resolved as a scope decision: composition is accepted; production process/CLI deployment remains future operational work. |
| M2-L022–L025 cursor/idempotency/evidence/outbox findings | Resolved by the combined live and package evidence; preserve the tests as regression coverage. |

## Release-blocker learnings — 2026-08-18

These observations were added after the provisional closure table. They are
open until the owning implementation and regression evidence are reported; the
earlier green counts do not close them.

| ID | Observation/evidence | Learning | Action/status |
|---|---|---|---|
| M2-L027 | A worker can evaluate an outcome using an observation clock that is stale relative to the lease/retry row. | Time is part of the concurrency contract; claim ownership and outcome deadlines need one authoritative clock boundary. | Centralize clock use in worker/repository transitions and add late-outcome/lease-expiry tests. Open/release blocker. |
| M2-L028 | Claim scope can be represented differently by claim, load, and outcome paths. | Authorization scope must be carried as an invariant with the claim, not reconstructed inconsistently by each operation. | Bind tenant/consumer/subscription scope through all claim operations and test cross-scope mutations. Open/release blocker. |
| M2-L029 | A signed body can be verified while transport headers remain independently trusted. | Cryptographic verification is only meaningful when routing metadata is derived from or cross-checked against the verified bytes. | Make header/body consistency a single adapter contract and test mismatch rejection. Open/release blocker. |
| M2-L030 | IPv6 mapped/embedded and alternate textual forms can evade a filter that checks only ordinary IPv4/private literals. | SSRF defenses must classify normalized resolved addresses, not string shapes or one address family. | Add an IPv4/IPv6 range matrix, normalization helper, and fail-closed resolver tests. Open/release blocker. |
| M2-L031 | Raw exceptions may be convenient diagnostics but can contain secrets and unbounded source/system data. | Durable error state needs a safe, bounded diagnostic vocabulary separate from server-side exception logging. | Introduce redacted error codes/details and assert secret-free persistence/API/log fields. Open/release blocker. |
| M2-L032 | Transport-neutral API handlers can pass unit tests without a durable consumer repository adapter. | A handler contract is not a production capability until its composition root connects auth, durable state, and error semantics. | Add and test the durable adapter while retaining transport neutrality; do not claim an HTTP server exists. Open/release blocker. |
| M2-L033 | Webhook signing is optional at configuration time even though delivery is expected to be authenticated. | Security-critical delivery requirements must fail closed at both configuration and send time. | Make key resolution mandatory for webhook mode and test missing/rotated/unknown key behavior. Open/release blocker. |
| M2-L034 | Legacy uniqueness constraints encode a single selector value while M2 permits normalized multi-value selectors and versions. | Compatibility schema rules can be more dangerous than an explicit migration when they silently reject valid state. | Audit legacy uniqueness, write only the normalized identity, and test multi-value/version coexistence. Open/release blocker. |
| M2-L035 | Observation samples and labels have no demonstrated resource bound. | Observability is an input surface: cardinality, bytes, retention, and redaction must be bounded like any other untrusted payload. | Enforce limits and allowlists at ingestion; add adversarial sample/label tests. Open/release blocker. |
| M2-L036 | Parent status and version status can describe different effective states. | Versioned resources need an atomic status source of truth or explicit consistency checks; otherwise selectors and documentation can drift. | Define parent/version transition invariants and test concurrent, retried, and mismatched updates. Open/release blocker. |
| M2-L037 | A caller-provided outbox hash is treated as authoritative. | Integrity hashes belong to the canonicalization/persistence boundary, not to untrusted request metadata. | Recompute hashes and reject drift; test wrong-hash inserts and retries. Open/release blocker. |
| M2-L038 | Selector enum values are accepted more broadly than the matcher/schema contract defines. | Strict enums protect both persistence invariants and routing behavior; future values require a versioned contract. | Share allowlists across schema/service/store and reject unknown values with regression fixtures. Open/release blocker. |

## Final fix-evidence review — 2026-08-18

The current checkout contains the fixes for M2-L027 through M2-L038. Local
package and pure evidence is green, but the final PostgreSQL run is not
available in this environment. These entries intentionally remain pending
until the conformance agent reports the serialized live gate green.

| ID | Current observation/evidence | Learning | Action/status |
|---|---|---|---|
| M2-L027 | Worker tests now advance the injected clock after slow transport and reject stale lease outcomes. | A worker's observation time is not a safe transition time after I/O; each state mutation needs a fresh authoritative clock. | Keep per-item/per-outcome clock tests and require live lease evidence. Pending final conformance report. |
| M2-L028 | Scope is carried through claim identity, repository transition inputs, and consumer/API operations. | Scope must be an invariant of the state transition, not a filter added only to the initial query. | Retain cross-tenant claim/ack/retry/replay tests and live predicates. Pending final conformance report. |
| M2-L029 | Runtime body/header checks and worker transport-header validation reject mismatched or overridden signed metadata. | Verify raw signed bytes first, then derive or cross-check all transport identity metadata before dispatch. | Preserve mismatch and header-injection fixtures. Pending final conformance report. |
| M2-L030 | SSRF tests cover normalized IPv6 forms embedding private IPv4 ranges. | Address-family conversion and textual normalization are part of SSRF policy, not parser trivia. | Keep the IPv4/IPv6 range matrix and fail-closed DNS behavior. Pending final conformance report. |
| M2-L031 | Worker persistence uses stable bounded error codes/messages; metrics observation storage is bounded. | Error and observability payloads are untrusted input surfaces and require the same redaction/size discipline as events. | Extend durable/API redaction assertions as adapters mature. Pending final conformance report. |
| M2-L032 | A durable PostgreSQL consumer repository now composes behind the transport-neutral API handlers. | Handler-level tests are insufficient without a durable composition seam that can be restarted and re-scoped. | Run the consumer repository composition test against PostgreSQL; keep HTTP deployment explicitly separate. Pending final conformance report. |
| M2-L033 | Consumer and persistence boundaries require a signing-key reference for webhook mode and reject it for pull mode. | Authentication requirements must be fail-closed at configuration and send boundaries, not inferred by the worker later. | Retain missing/unknown-key tests and live subscription constraints. Pending final conformance report. |
| M2-L034 | Legacy selector uniqueness is removed in favor of tenant/version/kind/value identity. | Compatibility columns must not silently define narrower semantics than the normalized contract. | Keep migration upgrade and multi-value selector tests. Pending final conformance report. |
| M2-L035 | Observation samples and labels are capped by the metrics sink and unknown series/labels collapse under configured bounds. | Observability resource limits are part of the M2 contract even when the production exporter is deferred. | Retain adversarial sample/cardinality tests and define exporter limits during operations work. Pending final conformance report. |
| M2-L036 | Parent subscription status and selector-version state are updated together with expected-version and future-activation checks. | Versioned resources need one transactional status transition and immutable version history. | Retain concurrent/version-status tests and live composition evidence. Pending final conformance report. |
| M2-L037 | Outbox persistence recomputes the canonical payload hash and rejects a caller-supplied mismatch. | Integrity hashes must be computed at the persistence boundary, never trusted from request metadata. | Retain wrong-hash and immutable-drift regressions. Pending final conformance report. |
| M2-L038 | Selector event types, routing modes, subscription statuses, and delivery modes are validated against strict allowlists. | Enum expansion requires a versioned contract instead of silently accepting arbitrary strings. | Retain schema/service/persistence enum fixtures. Pending final conformance report. |

## Final conformance resolution — 2026-08-18

The corrected full live gate is green with the PostgreSQL database configured:
architecture 4, pure conformance 6, live PostgreSQL 3, protocol-runtime 5,
delivery-core 18, delivery-consumer 10, persistence 11, webhook adapter 8,
delivery-worker 6, and delivery-api 5. All seven packages/applications pass
clean install, build, and test. These notes do not claim hosted GitHub CI.

| IDs | Resolution/evidence | Current status |
|---|---|---|
| M2-L027 | Per-delivery and post-transport clock refreshes, plus stale lease tests, prevent old observations from winning transitions. | Resolved for M2; retain fake-clock/live lease regression coverage. |
| M2-L028 | Scope is carried through claim identity, API auth context, and durable repository transitions; live isolation passes. | Resolved for M2; preserve scope predicates on every state mutation. |
| M2-L029 | Exact canonical body verification is paired with required header/body identity checks and transport-header denylisting. | Resolved for M2; protocol `0.1` wire contract remains frozen. |
| M2-L030 | IPv6 normalization inherits private-address policy for mapped, compatible, 6to4, and NAT64 embedded IPv4. | Resolved for M2; maintain the resolver address matrix. |
| M2-L031 | Stable redacted errors and bounded metric observations prevent untrusted diagnostics from becoming durable leakage or unbounded state. | Resolved for M2 contract; exporter deployment remains future work. |
| M2-L032 | The durable consumer repository adapter now composes with transport-neutral handlers and passes live restart/scope evidence. | Resolved for M2; HTTP transport remains separate. |
| M2-L033 | Webhook signing-key references are mandatory and pull mode rejects webhook-only configuration. | Resolved for M2; secret resolution/rotation is operational work. |
| M2-L034 | Normalized selector versions replace unsafe legacy single-selector uniqueness while preserving tenant/version identity. | Resolved for M2; compatibility migration tests remain required. |
| M2-L035 | Bounded observation samples and label/series policies pass core adversarial metrics tests. | Resolved for M2 contract; exporter deployment remains future work. |
| M2-L036 | Parent/version status transitions, selector versioning, and future activation pass consumer and live composition tests. | Resolved for M2; retain immutable version-history checks. |
| M2-L037 | Outbox rows recompute canonical hashes and reject caller-supplied drift; live outbox/idempotency coverage passes. | Resolved for M2; never weaken the hash guard. |
| M2-L038 | Selector enum allowlists are enforced through service, persistence, migration, and live validation paths. | Resolved for M2; new enum values require a versioned decision. |
| M2-L039 | Canonical fixture hashes exposed a test defect rather than a production integrity defect; tests now use the shared hash helper and retain wrong-hash assertions. | Resolved; never weaken the persistence hash guard. |
| M2-L040 | Root orchestration explicitly serializes package tests, preserving PostgreSQL migration assumptions and eliminating the runner-only deadlock. | Resolved; keep the serial runner flag in CI and local gate commands. |
| M2-L041 | Future-only selector activation controls which new outbox events are materialized; it must not redefine visibility of delivery rows already materialized under an older version. | Keep cursor version binding for stale-client rejection, but page all pending rows owned by the subscription. Test an unacknowledged old-version row across every selector update. Resolved in consumer service and PostgreSQL adapter. |
| M2-L042 | Stable error codes do not prevent disclosure if an adapter copies the original exception message into the public application error. | Redaction belongs at every adapter boundary, including the final unknown-error fallback and database constraint handling. Use generic client messages and controlled server-side logging. Resolved in the PostgreSQL consumer adapter. |
| M2-L043 | Local clean/live parity is necessary but does not establish that the checked-in GitHub workflow can reproduce it. | Record the first hosted workflow result as release-handoff evidence and keep the PR unmerged until it is green. GitHub Actions CI run #5 passed on draft PR #2 for commit `ad4ea3a`. |
