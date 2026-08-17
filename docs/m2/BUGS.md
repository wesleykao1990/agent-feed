# Milestone 2 bug and gap log

Status: **open items carried into implementation**

This is an append-only log. Do not silently rewrite an entry when a fix lands.
Append a resolution note with the commit, regression test, and validation date.

| ID | Symptom / evidence | Impact | Planned fix | Regression test | Status |
|---|---|---|---|---|---|
| M2-001 | `agent_feed.outbox_events.delivered_at` in `packages/persistence-postgres/migrations/0001_agent_feed.sql` is one global delivery marker. | The first successful consumer could make an event appear delivered to every other consumer. | Add per-subscription attempt/ack state in `0002_durable_delivery.sql`; never use the global column as acknowledgement truth. | Two consumers receive the same event; one succeeds while the other remains pending/retryable. | Open — design recorded in ADR-0002 |
| M2-002 | `prototype/src/events.ts` and `prototype/src/types.ts` use camelCase event fields, while `packages/schema/contracts/delivery-event.schema.json` is strict snake_case. | Signing or validating the wrong representation can produce a signature that is not the protocol wire body. | Add one snake_case wire conversion before signing; keep protocol `0.1` body unchanged. | Sign a converted event, validate the exact raw body with AJV, then reject a camelCase/altered body. | Open — design recorded in ADR-0005 |
| M2-003 | Canonical JSON exists in `prototype/src/wire.ts`, `prototype/src/security.ts`, and `packages/persistence-postgres/src/hash.ts`. | Different undefined/number/object handling can cause idempotency hashes and signatures to diverge. | Extract one `packages/protocol-runtime` canonicalizer and make existing callers delegate. | Cross-package corpus produces byte-identical canonical JSON and hashes. | Open — design recorded in ADR-0001/0005 |
| M2-004 | `0001_agent_feed.sql` reserves `outbox_events`, but `PostgresAgentFeedPersistence.submitBatch` and `completeRun` do not enqueue durable events. | Accepted findings can exist without a recoverable delivery record. | Add a transaction-aware outbox writer and invoke it before the existing ingress transaction commits. | Failed batch rolls back findings/evidence/outbox; exact retry creates no duplicate outbox rows; terminal event appears once. | Open — design recorded in ADR-0002 |
| M2-005 | M1 tables and repository methods have no consumer/tenant/subscription authorization scope. | A delivery query or replay endpoint could expose another consumer's feed. | Scope subscriptions, attempts, acks, cursors, dead letters, and service methods by authenticated consumer/tenant principal. | Consumer A cannot list, claim, pull, ack, or replay Consumer B's event even with guessed IDs. | Open — design recorded in ADR-0004 |
| M2-006 | `MIGRATION_SQL_URL` in `packages/persistence-postgres/src/postgres-store.ts` points only to `0001_agent_feed.sql`. | A deployed M2 service cannot reliably apply the new durable-delivery schema. | Add ordered migration discovery/checking and test clean plus existing-M1 upgrades. | Migration runner applies 0001 then 0002 idempotently and rejects gaps/out-of-order files. | Open — implementation required before M2 operational use |
| M2-007 | `prototype/src/store.ts` computes a batch idempotency hash from `{ findings, evidence }` only. `batchId`, `idempotencyKey`, and other request fields are outside that hash. | A changed batch identity or request metadata can be treated as the same payload under an idempotency key, weakening conflict detection. | Define the complete canonical idempotency payload and align the prototype with the durable service boundary. | Reusing a batch key with changed batch identity/request fields is rejected; exact retries remain idempotent. | Open — implementation and regression test required |

## Resolution and follow-up notes — 2026-08-18

The following notes are append-only status updates from the M2 foundation
checkout. “Partial” means a pure or structural guard exists but the durable,
live, or end-to-end proof is still missing.

| ID | Resolution/evidence on 2026-08-18 | Residual risk/status |
|---|---|---|
| M2-001 | `0002_durable_delivery.sql` adds per-subscription delivery rows and the structural migration suite passes. No delivery repository or ingress integration currently uses those rows. | Partial/open — live two-consumer delivery and repository tests remain required. |
| M2-002 | `packages/protocol-runtime` emits strict canonical snake_case wire bodies; its 5/5 tests cover exact encoding and signed headers. The prototype's older camelCase helper is still present and has not been delegated. | Partial/open — one runtime boundary must replace the M1/prototype signing callers. |
| M2-003 | The runtime canonicalizer/HMAC implementation exists and is exercised by protocol-runtime tests. `prototype/src/wire.ts`, `prototype/src/security.ts`, and `packages/persistence-postgres/src/hash.ts` still contain independent helpers. | Open — duplicate canonical JSON and HMAC behavior can still drift; add cross-package parity and migrate callers. |
| M2-004 | The additive migration defines the durable outbox/fan-out shape, but `PostgresAgentFeedPersistence` has no transaction-aware outbox writer and no event rows are proven on batch/complete commit. | Open — rollback, exact retry, and terminal-event atomicity are release blockers. |
| M2-005 | Tenant/consumer columns and pure consumer-service scope checks exist; the API handler tests cover credential-derived scope and cross-tenant `404`. No live PostgreSQL repository or production auth adapter is wired. | Partial/open — prove list/claim/pull/ack/replay isolation against durable rows. |
| M2-006 | `0002` includes a schema-migrations table, but `migrateAgentFeed` still reads the single `0001_agent_feed.sql` URL. | Open — implement ordered discovery, gap detection, idempotence, and clean/upgrade tests. |
| M2-007 | The prototype batch hash omission remains documented; no M2 change has yet aligned the prototype's full request hash with the durable ingress contract. | Open — add changed-identity conflict and exact-retry regression tests. |
| M2-008 | The consumer selector matcher now delegates to delivery-core's normalized matcher, reducing the earlier core/consumer behavior split. Core and consumer tests pass independently, but normalization/parity is not yet proven as a package-level contract and the consumer currently imports the core source path directly. | Partial/open — add shared parity fixtures and enforce dependency/package-boundary checks. |
| M2-009 | `InMemoryMetricsSink` can allowlist names/keys, collapse values, and cap series; the core metrics test is included in the 11/11 package suite. The generic `MetricsSink` accepts arbitrary labels and the worker currently emits only a local `event_type` label without a production allowlist. | Partial/open — define and test the production adapter's bounded label policy. |
| M2-010 | Protocol-runtime, delivery-core, delivery-consumer, persistence-postgres, and delivery-api have individual package lockfiles and independent build/test scripts. Root scripts/CI do not yet install/build/test every M2 package, and no root lockfile policy enforces a clean workspace install. | Open — add root/CI parity and a clean-build artifact check. |
| M2-011 | The protocol-runtime encoder/signer tests (5/5), pure M2 conformance retry test (6 passing, 1 explicit skip), and delivery-worker signer test (4/4) now prove that attempt changes raw bytes/signature while source identity remains stable. A live repository replay/lease integration proof is still absent. | Frozen protocol compatibility debt/partial — retain the v0.1 body rule and add live replay evidence. |
| M2-013 | Multi-stream selectors exposed a cursor-ordering flaw: a single cursor cannot safely paginate a union when positions are only per-stream. The frozen resolution is a tenant-global monotonically increasing delivery position; the schema may retain the historical `stream_position` column name for compatibility. This gives one total pull order and a future-only activation boundary across all selected streams. | Open until migration/repository code and same-position/multi-stream tests implement the global allocator and reject old per-stream assumptions. |

The M2-013 decision is intentionally recorded before implementation lands. Do
not mark it complete from a structural column name alone; the acceptance proof
must show no duplicate/skip across a multi-stream page boundary, monotonic
positions under concurrent inserts, and cursor scope/selector-version binding.

## Emerging implementation update — 2026-08-18

The shared worktree advanced after the foundation snapshot. These notes record
what is now present without treating skipped live tests or source-only code as
an operational completion signal.

| ID | New evidence | Remaining status |
|---|---|---|
| M2-001/M2-004 | `appendOutboxEventInTransaction` is called from `beginRun`, `submitBatch`, and `completeRun`; `migrateAgentFeed` applies the known M1 and M2 SQL in one startup path. | Partial/open — live rollback, exact retry, event fan-out, and terminal atomicity tests remain skipped without PostgreSQL. |
| M2-005 | `PostgresDeliveryRepository` query methods carry tenant, consumer, and subscription predicates; transport-neutral API tests cover credential scope. | Partial/open — enable live isolation/claim/ack/pull/replay tests and review every repository join/predicate. |
| M2-006 | The loader now applies the two known migration files sequentially when no SQL override is supplied. | Partial/open — replace the fixed pair with ordered directory discovery, gap detection, and migration ledger validation. |
| M2-013 | `0002` now retains compatibility `stream_position` while adding tenant-global `delivery_position`/`tenant_event_counters`; the repository orders and activates by `delivery_position`. | Partial/open — structural tests pass, but live concurrent multi-stream cursor/activation proof is absent. |
| M2-014 | Production source imports briefly used the non-exported `@agent-feed/delivery-core/src/types.ts` subpath. The current shared source now uses public package names and the webhook package declares file dependencies/exports. | Partial — retain a production-import audit forbidding `/src` subpaths and prove a clean install/lockfile resolution before closing. |
| M2-015 | The durable repository foundation exists, while `postgres-conformance.test.ts` intentionally skips live repository/lease/pull cases without a database URL. | Partial/open documentation and acceptance gap — keep the live skip explicit, test the repository foundation where possible, and do not count skips as green. |
| M2-016 | The transport-neutral `apps/delivery-api` source and lockfile initially failed with `ERR_MODULE_NOT_FOUND` for `@agent-feed/delivery-consumer`, and `npm run build` could not find `tsc`, because `node_modules` was empty. | Resolved locally after package dependencies were installed: current API run is 3/3 tests plus build. Retain clean-install/CI verification before closing. |
| M2-017 | `apps/delivery-worker` now has composition, signer, retry bridge, recovery cycle, and abortable loop tests (4/4), but no deployment/CLI entrypoint or live PostgreSQL/webhook integration exists. | Partial/open — wire the tested composition to a deployable process and prove outage, lease, retry, and external receiver behavior. |

### Final sweep amendments — 2026-08-18

| ID | Current evidence | Residual status |
|---|---|---|
| M2-006 | The loader now applies the known `0001` and `0002` migrations sequentially when no SQL override is supplied; persistence structural tests pass. | Partial/open — arbitrary ordered directory discovery, gap rejection, and live upgrade/rollback evidence remain. |
| M2-008 | `delivery-consumer` now imports the public `@agent-feed/delivery-core` package and delegates matching through its exported matcher; current consumer/core suites pass. | Partial/open — shared normalization fixtures and a clean-install/package-boundary audit remain. |
| M2-011 | The current pure conformance harness has 6/6 tests passing with no repository skip; PostgreSQL replay/lease evidence remains explicitly gated by `AGENT_FEED_DATABASE_URL`. | Frozen protocol compatibility debt/partial — preserve body-level `attempt` and add live replay evidence. |

| M2-018 | A pull cursor can be unsafe if an adapter treats base64-encoded JSON as opaque without authenticating it; a caller could alter position or scope. | `BoundCursorCodec` now delegates canonicalization and signing/verification to protocol-runtime, and the PostgreSQL repository requires that codec for pull. Core tamper/expiry/scope tests and the live-oriented repository fixture cover rejection, but the database fixture is skipped without PostgreSQL. | Partial — pending combined-test and live cursor-tamper evidence. |
| M2-019 | M1's begin idempotency uniqueness did not include tenant scope, so identical producer/stream/key tuples in different tenants could conflict. | `0002_durable_delivery.sql` replaces the old uniqueness with `(tenant_id, producer_id, stream_id, begin_idempotency_key)`; the repository fixture exercises the same key independently in two tenants. | Partial — pending combined-test and live migration evidence. |
| M2-020 | Finding delivery payloads can degrade into evidence IDs only, leaving a consumer without the submitted evidence object at the delivery boundary. | `submitBatch` now builds each finding event's `submitted_evidence` from the full evidence payload map; the repository fixture compares the outbox payload with the submitted evidence object. | Partial — pending combined-test and live outbox evidence. |
| M2-021 | `ON CONFLICT DO NOTHING` on an event key can hide an immutable-event drift (changed event type, stream, finding, tags, hash, or eligibility) on retry. | `appendOutboxEventInTransaction` locks the existing row and compares immutable fields, raising `outbox_event_idempotency_conflict` on drift; the repository fixture changes an event type under one key. | Partial — pending combined-test and live conflict evidence. |
| M2-022 | A package-name import once bypassed the public boundary through `@agent-feed/delivery-core/src/*`, which can compile locally while violating exports or failing a clean install. | Production imports now use public package names, package manifests declare file dependencies/exports, and the architecture audit forbids source subpaths. | Partial — pending combined-test clean-install audit; retained as a regression guard alongside M2-014. |

## M2 implementation-gate resolution — 2026-08-18

The combined acceptance is green: architecture 4, pure conformance 6, live
PostgreSQL 3, protocol-runtime 5, delivery-core 11, delivery-consumer 8,
persistence-postgres 9, webhook-adapter 7, delivery-worker 4, and
delivery-api 3. All seven M2 packages/applications have clean installs,
builds, and tests. The entries below are the current status index; the earlier
rows remain append-only historical observations.

| IDs | Current resolution | Status |
|---|---|---|
| M2-001, M2-004 | Per-subscription state, transaction-aware outbox writes, rollback/idempotency, and tenant fan-out pass the 3/3 live PostgreSQL suite. | Resolved for M2; global `delivered_at` remains compatibility-only. |
| M2-002, M2-003 | Protocol-runtime owns production canonical JSON/HMAC and exact snake_case signing; persistence, worker, and webhook paths use the public runtime boundary. Prototype helpers remain historical reference code. | Resolved for M2; non-production reference duplication is nonblocking. |
| M2-005 | Tenant/consumer/subscription predicates, API credential scope, cross-tenant isolation, acknowledgements, replay, and cursor scope pass live acceptance. | Resolved. |
| M2-006 | The loader explicitly applies `0001_agent_feed.sql` then `0002_durable_delivery.sql`, and live migration/repository acceptance passes. | Resolved for the M2 scope; arbitrary future migration discovery/gap checking is deferred operational work. |
| M2-007 | The complete durable ingress hash/conflict contract is covered by the PostgreSQL implementation. The in-memory prototype's narrower batch hash remains a documented reference limitation. | Retained nonblocking prototype debt; not an M2 delivery-gate failure. |
| M2-008, M2-013, M2-014 | Shared selector normalization, tenant-global multi-stream positions, public package imports/exports, and clean-install boundaries pass combined acceptance. | Resolved for M2; keep regression checks. |
| M2-009 | Bounded metrics behavior and redaction pass the pure/core and combined tests. | Resolved for M2 contract; production exporter/deployment is future operational work. |
| M2-010, M2-016 | The repository workflow definition covers all seven M2 packages/apps; clean installs/builds/tests pass locally, including API 3/3. | Resolved in repository configuration; no hosted GitHub CI result is claimed. |
| M2-011, M2-015, M2-017 | Attempt/signature lineage, conformance fixtures, worker composition/recovery, and live PostgreSQL lease/retry/replay paths pass. | Resolved for M2; production worker process/CLI and external deployment remain future work. |
| M2-018, M2-019, M2-020, M2-021, M2-022 | Signed cursors, tenant-scoped idempotency, full evidence payloads, immutable outbox drift conflicts, and package public-boundary imports pass the combined evidence. | Resolved for M2; retain clean-install and live regression tests. |

## Release-blocker audit — 2026-08-18

The following items were encountered after the provisional implementation-gate
closure index above. They supersede that index for release readiness: each item
is **open/pending** until its owner supplies an implementation report and
regression evidence. No row below should be treated as resolved by the earlier
combined acceptance counts.

| ID | Symptom / evidence | Impact | Planned fix | Regression test | Status |
|---|---|---|---|---|---|
| M2-023 | Worker outcome handling can use a stale outcome clock when a lease, retry, or completion transition is evaluated after the worker's observation time. | A stale worker may win a transition or calculate an incorrect retry/lease deadline. | Use one authoritative, transaction-consistent clock for claim, outcome, lease, and retry transitions; reject outcomes based on stale ownership/time. | Advance an injected clock across lease expiry and submit late success, retry, and failure outcomes; assert only the current owner/time window can transition the row. | Open — release blocker; owner report/test pending |
| M2-024 | Claim scope does not remain identical across claim, load, and outcome operations; the caller's scope and the persisted claim scope can diverge. | A consumer or tenant could observe or mutate a claim outside its authorized scope. | Bind tenant, consumer, subscription, and claim identifiers together at every repository/service boundary and derive scope from authenticated context. | Claim in scope A, then attempt load, ack, retry, dead-letter, and release with scope B; assert not-found/forbidden behavior and unchanged state. | Open — release blocker; owner report/test pending |
| M2-025 | Signed event headers and the signed body are not yet proven to be mutually trusted; a transport header can disagree with a field in the verified event body. | A receiver could route, authorize, or deduplicate a different event than the one cryptographically verified. | Verify the exact raw body, derive trusted identity fields from that body, and cross-check any required headers before dispatch; reject mismatches. | Mutate event ID, attempt, tenant, stream, timestamp, or payload-hash headers independently of the signed body and assert rejection before handler invocation. | Open — release blocker; owner report/test pending |
| M2-026 | SSRF filtering does not yet demonstrate rejection of IPv6 embedded-private and IPv4-mapped addresses or equivalent alternate textual forms. | A webhook target that looks public textually could resolve to loopback, private, link-local, or metadata infrastructure. | Normalize and classify all resolved IPv4/IPv6 forms, including mapped/embedded addresses, and deny private, loopback, link-local, reserved, and metadata ranges. | Exercise IPv4-mapped IPv6, IPv4-compatible/embedded-private, compressed, expanded, and alternate-notation addresses; assert fail-closed before connection. | Open — release blocker; owner report/test pending |
| M2-027 | Raw exception text can cross the persistence boundary into stored error details or delivery records. | Database messages, URLs, credentials, or source data may be retained and exposed through APIs, replay, or logs. | Persist stable bounded error codes and redacted diagnostic metadata only; keep raw exceptions in controlled server logs with redaction. | Throw exceptions containing secrets, SQL text, URLs, and oversized payloads; assert stored rows/API responses contain neither raw text nor secrets. | Open — release blocker; owner report/test pending |
| M2-028 | The transport-neutral consumer API lacks a durable adapter that proves handler operations are wired to the PostgreSQL repository and authenticated scope. | Unit-level handler success can mask a missing production composition path; claim/pull/ack/replay may not be durable. | Add an explicit durable consumer API adapter/composition boundary without assuming an HTTP server, and wire it to the repository, auth context, and error mapping. | Run the adapter against live PostgreSQL for claim, pull, ack, retry/replay, and scope isolation; verify the same state is visible after a new process/context. | Open — release blocker; owner report/test pending |
| M2-029 | Webhook delivery can be configured without a signing key or fall back to an unsigned send. | Consumers cannot authenticate delivery and the system may violate the signed-webhook contract. | Require a valid signing key for webhook subscriptions and fail closed at registration and delivery when it is absent, unknown, or unusable. | Register/send with missing, empty, rotated, and unknown keys; assert no unsigned request is emitted and a bounded failure is recorded. | Open — release blocker; owner report/test pending |
| M2-030 | Legacy selector uniqueness rules treat independently valid multi-value selector rows as duplicates or force them into one legacy value. | Adding streams, event types, or routing tags can fail, overwrite state, or create false conflicts during migration. | Replace legacy single-value uniqueness assumptions with the versioned, normalized selector identity used by M2; preserve compatibility reads without compatibility writes. | Create multiple valid streams/event types/tags under one subscription and across versions; assert no false conflict, overwrite, or cross-tenant collision. | Open — release blocker; owner report/test pending |
| M2-031 | Observation samples and diagnostic labels are accepted without a bounded count, size, or cardinality policy. | A hostile or noisy producer can exhaust memory/storage or create unbounded metric cardinality. | Enforce allowlisted fields, maximum sample count/bytes, bounded label values, redaction, and deterministic truncation/eviction at the observation boundary. | Submit oversized samples, many samples, high-cardinality labels, and secret-bearing values; assert bounded output, redaction, and stable rejection/truncation. | Open — release blocker; owner report/test pending |
| M2-032 | Parent and version status fields can drift: a current parent record and its version/snapshot metadata do not share one validated status transition. | Consumers may act on stale selector/schema/subscription state or documentation may report a status that does not describe the active version. | Define one authoritative status/version transition and validate parent/version consistency on create, publish, update, and read paths. | Attempt mismatched parent/version status and version updates, including retries and concurrent updates; assert atomic rejection or synchronized state. | Open — release blocker; owner report/test pending |
| M2-033 | The outbox boundary accepts a caller-supplied payload/event hash instead of always recomputing it from the canonical immutable event. | A caller can create hash drift, bypass idempotency/conflict detection, or make a stored signature/hash disagree with delivered bytes. | Recompute canonical payload hash inside the persistence boundary, ignore or compare caller hints, and reject immutable drift. | Supply an incorrect hash on first insert and retry with changed payload/hash; assert recomputation or explicit conflict and byte/hash consistency. | Open — release blocker; owner report/test pending |
| M2-034 | Selector enum fields accept weakly validated strings rather than a strict allowlist for event type, match mode, or selector status. | Invalid values can reach SQL and matching logic, producing undefined routing or bypassing validation assumptions. | Validate every selector enum at schema, service, and persistence boundaries with one exported allowlist; reject unknown/case-variant values. | Submit unknown, empty, case-variant, and future-looking enum values through create/update/read paths; assert deterministic validation failure and no persisted row. | Open — release blocker; owner report/test pending |

## Final fix-evidence review — 2026-08-18

The implementation pass for M2-023 through M2-034 is present in the shared
checkout. The package and pure suites pass locally (core 18, consumer 9,
webhook 8, worker 6, API 5, protocol-runtime 5); the PostgreSQL suites are
explicitly skipped here because `AGENT_FEED_DATABASE_URL` is not set. These
entries are therefore recorded as implementation evidence, not final
resolution. The conformance agent must report a green serialized live run
before their status changes to resolved.

| ID | Fix evidence in current checkout | Regression evidence observed | Status |
|---|---|---|---|
| M2-023 | Worker refreshes the clock per delivery and again after transport before retry/ack/dead-letter transitions; repository outcomes carry the claim scope and lease token. | `packages/delivery-core/test/delivery-core.test.ts`: slow-transport clock tests and stale-lease outcome test; live lease/recovery suite remains required. | Pending final conformance report — not marked resolved |
| M2-024 | Claim identity validation and tenant/consumer/subscription predicates are enforced before signing and across durable transitions. | Core claim-mismatch tests, consumer scope tests, API cross-tenant tests, and live repository isolation cases; final live report pending. | Pending final conformance report — not marked resolved |
| M2-025 | Protocol runtime cross-checks event ID, attempt, and protocol version against the canonical body; worker validates signed metadata and required headers before transport. | Protocol signing tests plus worker header/body, claim identity, and transport-header override tests; final live/webhook report pending. | Pending final conformance report — not marked resolved |
| M2-026 | SSRF classification normalizes IPv4-mapped, IPv4-compatible, 6to4, and well-known NAT64 IPv6 forms before public-address approval. | `packages/webhook-adapter/test/webhook-adapter.test.ts` private/mixed DNS and embedded-private cases pass; final conformance report pending. | Pending final conformance report — not marked resolved |
| M2-027 | Worker error persistence now uses bounded stable codes and generic messages, excluding injected exception text. | Core redaction test passes; durable/API error-surface review remains part of the final conformance report. | Pending final conformance report — not marked resolved |
| M2-028 | `PostgresDeliveryConsumerRepository` now implements the durable consumer repository port and is composed through the transport-neutral API boundary. | `packages/persistence-postgres/test/delivery-consumer.test.ts` and API scope tests exist; the live consumer-adapter test is skipped without PostgreSQL. | Pending final conformance report — not marked resolved |
| M2-029 | Webhook subscriptions require both endpoint and signing-key references in consumer validation, persistence validation, and the additive SQL shape; pull subscriptions reject webhook fields. | Consumer and API configuration tests plus migration constraints; final live registration/rotation report pending. | Pending final conformance report — not marked resolved |
| M2-030 | The additive migration drops the unsafe legacy selector uniqueness index and stores normalized selector/version rows with tenant-scoped identity. | Migration assertions and normalized selector service tests pass; live upgrade/multi-value coexistence report pending. | Pending final conformance report — not marked resolved |
| M2-031 | Metrics observations are capped per series and unknown labels/series are collapsed under configured bounds. | Core metrics cardinality and sample-cap tests pass; production exporter remains future operational work. | Pending final conformance report — not marked resolved |
| M2-032 | Subscription parent rows and immutable selector-version rows are updated in one transaction, with expected-version checks and future activation positions. | Consumer selector-version tests and persistence composition tests exist; final live concurrent/version-status report pending. | Pending final conformance report — not marked resolved |
| M2-033 | Outbox persistence recomputes the canonical payload hash and rejects caller-supplied mismatches before insert/conflict comparison. | Persistence regression asserts a wrong caller hash is rejected; live outbox/idempotency report pending. | Pending final conformance report — not marked resolved |
| M2-034 | Selector event types, routing modes, subscription statuses, and delivery modes use strict allowlists in runtime/service/persistence boundaries. | Core/consumer/API/migration validation tests pass; final live invalid-enum report pending. | Pending final conformance report — not marked resolved |

## Final integration discoveries — 2026-08-18

These two integration issues were found while exercising the hardened
implementation. They are recorded separately because each concerns the
acceptance harness rather than weakening a production invariant. They remain
pending until the conformance agent reports a green live run.

| ID | Symptom / evidence | Impact | Fix applied | Regression test | Status |
|---|---|---|---|---|---|
| M2-035 | Canonical outbox hashing correctly rejected placeholder live-fixture hashes that were unrelated to each event payload. | A valid integrity guard appeared to fail, creating pressure to weaken the store or accept hash drift. | Changed live fixtures to compute `payloadHash(payload)` from the canonical payload; retained rejection of an explicitly wrong caller hash. | `tests/delivery/postgres-conformance.test.ts` uses canonical fixture hashes; `packages/persistence-postgres/test/delivery.test.ts` asserts `outbox_event_payload_hash_mismatch` for a wrong hash. | Pending final conformance report — fix present, not marked resolved |
| M2-036 | The root M2 runner enumerated persistence test files but did not pass the package's serial `--test-concurrency=1` policy, allowing migrations/fixtures to race. | Concurrent PostgreSQL migrations could deadlock or make a green package script fail under the root gate. | Root runner now invokes every package test file with `--test-concurrency=1`, preserving deterministic serialized persistence execution. | `node scripts/run_m2_conformance.mjs --allow-live-skip` completes all local suites; final live run must exercise the serialized persistence package. | Pending final conformance report — fix present, not marked resolved |

## Final conformance resolution — 2026-08-18

The root agent reran the corrected full gate against PostgreSQL after the
M2-023 through M2-036 fixes. The serialized runner and all seven clean
package installs/builds/tests are green. No hosted GitHub CI result is implied.

| IDs | Resolution/evidence | Residual risk/status |
|---|---|---|
| M2-023 | Worker clock refreshes are covered by the core slow-transport tests; the live lease/recovery/replay suite confirms stale outcomes cannot mutate a reclaimed lease. | Resolved for M2. Keep fake-clock and live lease regression tests. |
| M2-024 | Claim identity and scope are validated before signing and carried through repository transitions; core, consumer, API, and live isolation paths pass. | Resolved for M2. Keep tenant/consumer/subscription predicates on every transition. |
| M2-025 | Protocol-runtime body/header cross-checks and worker signed-header validation reject mismatches and transport overrides before network I/O; protocol/webhook/worker suites pass. | Resolved for M2. Preserve the strict raw-body and header contract. |
| M2-026 | Normalized mapped/compatible/6to4/NAT64 IPv6 checks reject embedded private addresses; webhook tests and the full gate pass. | Resolved for M2. Continue extending the address-range matrix with any new resolver policy. |
| M2-027 | Worker and durable delivery error paths persist bounded stable codes/generic messages; the redaction test and full PostgreSQL gate pass without raw exception leakage. | Resolved for M2. Keep redaction at every adapter/API boundary. |
| M2-028 | `PostgresDeliveryConsumerRepository` is composed behind the transport-neutral API boundary; the live consumer composition test and API scope tests pass. | Resolved for M2. HTTP deployment remains future operational work. |
| M2-029 | Webhook configuration requires both endpoint and signing-key references, while pull rejects webhook fields; consumer/API tests, SQL constraints, and live persistence tests pass. | Resolved for M2. Key rotation/secret resolution remains an operational concern. |
| M2-030 | The unsafe legacy selector uniqueness index is removed and normalized tenant/version/kind/value selector rows are used; migration and live multi-value coverage pass. | Resolved for M2. Retain compatibility migration tests. |
| M2-031 | Observation samples are capped and metric labels/series are bounded; core adversarial metrics tests pass and the full gate remains green. | Resolved for M2 contract. Production exporter/deployment remains future operational work. |
| M2-032 | Parent subscription and selector-version state changes are transactional, expected-version checked, and future-position bound; consumer and live composition/version tests pass. | Resolved for M2. Preserve immutable version history and concurrent-update tests. |
| M2-033 | Outbox persistence recomputes canonical payload hashes and rejects caller-supplied mismatches; live outbox/idempotency coverage passes. | Resolved for M2. Never weaken the canonical hash guard for fixtures or callers. |
| M2-034 | Event type, routing mode, subscription status, and delivery mode are strictly allowlisted across service, persistence, schema, and migration boundaries; full package/live gate passes. | Resolved for M2. Add a new versioned decision before accepting new enum values. |
| M2-035 | Live fixtures now compute `payloadHash(payload)` canonically; the wrong-hash negative test remains, and the live gate passes without weakening store validation. | Resolved. Keep canonical fixture builders beside production payload contracts. |
| M2-036 | The root runner now passes `--test-concurrency=1` for every package test invocation; the full live run completes persistence migrations without deadlock. | Resolved. Keep serialized persistence execution in repository-level orchestration. |

## Root orchestration final review — 2026-08-18

The root review found two additional adapter defects after the agent audits had
reported green. Both fixes were exercised against the disposable PostgreSQL
database before the checksum manifest was regenerated.

| ID | Symptom / evidence | Impact | Resolution and regression evidence | Status |
|---|---|---|---|---|
| M2-037 | An un-cursored pull started at the newest selector version's activation position, and the PostgreSQL adapter also filtered rows to that version. | A delivery materialized under the previous selector version could become permanently invisible after a future-only selector update, blocking the contiguous ACK watermark. | Un-cursored reads now begin at zero over materialized pending rows, while cursor tokens remain bound to the current selector version. The repository no longer filters pending rows by selector version. Consumer unit coverage and the live PostgreSQL composition test leave an old-version row pending, update the selector, and prove both the old and new rows remain pullable. | Resolved for M2. Keep cross-version pending-delivery coverage. |
| M2-038 | The PostgreSQL consumer adapter's unknown-error fallback returned raw exception text, and its uniqueness error included a database constraint name. | Internal SQL/schema details or injected source text could escape through the transport-neutral API error mapping. | Repository fallbacks now return fixed generic messages; known errors retain stable codes without constraint names. TypeScript builds, consumer tests, and the live PostgreSQL suite pass. | Resolved for M2. Raw database exceptions remain server-side only. |

Release handoff evidence: GitHub Actions CI run #5 passed on draft PR #2 for
commit `ad4ea3a`. This validates the hosted workflow definition in addition to
the local clean/live evidence above; the PR remains intentionally unmerged.

## Resolution-note format

Append entries in this form when an item is fixed:

```text
Resolution: M2-000 (YYYY-MM-DD)
Fix commit/PR: <hash or link>
Regression evidence: <test command and result>
Residual risk: <none or explicit follow-up>
```
