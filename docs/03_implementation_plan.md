# Agent Feed implementation plan v0.1.1

## Milestone 0 — Protocol freeze

Deliver the nine Draft 2020-12 schemas, generated TypeScript/Python types, semantic checks, examples, and compatibility policy.

Gate:

- every example validates;
- a finding cannot be represented as a verified consumer fact;
- evidence references resolve within the run or are explicitly marked unresolved;
- complete-run counts reconcile with accepted batches;
- protocol version is pinned to `0.1`;
- expected stream cadence and overdue state validate independently of producer claims;
- the runnable prototype tests pass.

## Milestone 1 — Persistence and REST ingress

Status: **corrective implementation and Agent Feed release gates green**.
`schema-v0.1.1` published the immutable schema artifact from commit `ad7e1a7`.
The separate Rewards Optimizer dependency pin is downstream work and is not
part of this repository's Milestone 3. `apps/api` is an executable producer
HTTP adapter composed through `@agent-feed/producer-service` and backed by
PostgreSQL. The prototype remains supporting in-memory evidence only. The
corrective acceptance matrix and exact evidence are in
`docs/m1-hardening/ACCEPTANCE.md`.

Deliver:

- separate agent-feed database/schema;
- idempotent `begin`, `submit batch`, and `complete` services;
- immutable findings/evidence and append-only run events;
- producer authentication and stream-scoped authorization;
- size/rate limits, payload hashing, and PII/secret rejection hooks;
- REST endpoints and local-file run-bundle importer.

The corrective implementation must also deliver a publishable
`@agent-feed/schema` artifact. Its package version is independent of wire
protocol version `0.1`; the Rewards Optimizer must consume an immutable exact
version and record the artifact's integrity digest and source commit. A
workspace link, branch reference, floating range, or source-only schema
directory is not release evidence.

Gate:

- repeating an idempotency key returns the original result without duplicate rows;
- completing a run twice is deterministic and cannot change its terminal state;
- partial and failed runs preserve actual scope and errors;
- zero-finding completed runs are queryable;
- expected streams that miss a terminal run become overdue;
- terminal runs and accepted batches/findings/evidence are immutable;
- hostile findings retain security flags and are eligible for quarantine;
- every lifecycle operation is exercised through the executable REST adapter
  against PostgreSQL, including restart durability and exact-retry behavior;
- the schema package can be packed, published or attached as an immutable
  artifact, and its exact integrity pin is verified by a clean consumer install;
- the complete M0/M1/M2 gate is rerun with no live-PostgreSQL skips.

All implementation checks pass and the Agent Feed release action is complete.
The immutable release facts are recorded in `docs/m1-hardening/ACCEPTANCE.md`.
Whether the separate Rewards Optimizer has merged its exact dependency pin is
tracked in that repository and does not block later Agent Feed milestones.

## Initial build constraint

Before the Rewards conserved kernel and monitoring rehearsal are working, implement only the minimal generic surface: protocol, persistence, local-file import, one REST path, liveness, and signed event generation. Defer Python SDK, generic webhook, Claude hook, polished MCP deployment, admin dashboard, and a separate production Supabase project until a second consumer or measured volume justifies them. The project remains separate in source and contract even when local development uses one temporary database.

## Milestone 2 — Durable consumer delivery

Status: **implementation gate complete in this repository**. The corrected
full acceptance is green: architecture 4, pure conformance 6, live PostgreSQL
3, protocol-runtime 5, delivery-core 18, delivery-consumer 10,
persistence-postgres 11, webhook adapter 8, delivery-worker 6, and
delivery-api 5. All seven M2 packages/applications pass clean installs,
builds, and tests; M2-023 through M2-038 and M2-L027 through M2-L042 are
resolved in the append-only bug/learning logs. The repository workflow is configured to install/build/test
all seven and require live PostgreSQL. Hosted GitHub Actions CI run #5 passed
on draft PR #2 for commit `ad4ea3a`.
The API remains transport-neutral without an HTTP server; worker process
deployment and observability export remain future operational work. Migration
loading is intentionally explicit `0001`, `0002`, then `0003`, not arbitrary
directory discovery. See `docs/12_milestone_2_delivery.md` and
`docs/adr/README.md`.

Deliver:

- transactional outbox;
- queue-backed delivery workers;
- consumer subscriptions by stream, finding type, and routing tag;
- signed webhook delivery and optional pull cursor;
- exponential retry, dead-letter state, replay, and acknowledgement;
- end-to-end trace IDs and delivery metrics.

Gate:

- consumer downtime does not lose findings;
- duplicate delivery is safe;
- one consumer cannot read another consumer's feed;
- external delivery is documented as at-least-once;
- Realtime is not used as a queue.

The signed `DeliveryEvent` body remains protocol `0.1`; its required `attempt`
field changes on retry/replay while event ID, payload, occurred time, and
payload hash remain stable. The live PostgreSQL gate covers the durable
outbox, fan-out, leases, replay, and scope-bound cursor paths. Transport-neutral
consumer handlers are accepted as the application boundary; an HTTP server is
an explicitly deferred operational adapter. Do not add undocumented body
fields or treat a future production deployment as already present.

This M2 status is scoped to the durable delivery implementation and its
recorded acceptance evidence. Durable producer ingress and the immutable
schema artifact are accepted through `docs/m1-hardening/ACCEPTANCE.md`.

## Milestone 3 — MCP, SDKs, and adapters

Status: **implementation and hosted pull-request CI gates green**. GitHub
Actions run `32089066103` passed on draft PR #4 at source commit `52594aa`.
The integrated branch supplies the current MCP server, TypeScript and Python
SDKs, producer adapters, capability-gated skills, examples, and a no-skip M3
gate. See `docs/13_milestone_3_mcp_sdks_adapters.md` and `docs/m3/` for the
acceptance matrix, decisions, bugs, learnings, and modularity review.

Deliver:

- MCP tools `begin_run`, `submit_batch`, and `complete_run`;
- TypeScript and Python producer/consumer SDKs;
- Claude hook, REST, generic-webhook, and local-file adapters;
- ChatGPT and Claude skills;
- capability-gated ChatGPT Scheduled Task direct MCP path with validated
  run-bundle fallback.

Gate:

- REST and MCP call the same application service;
- an agent that cannot call tools can produce an importable run bundle;
- adapter failures close or preserve a partial run instead of silently disappearing.

The current private acceptance deployment reuses the stdio MCP server through
OpenAI Secure MCP Tunnel. Do not add a second ChatGPT-specific lifecycle
implementation. Public plugin distribution is a separate future deployment
decision requiring stable HTTPS streamable HTTP and production authentication.

## Milestone 4 — Rewards Optimizer reference consumer

Status: **local and hosted gates green on draft PR #5**.

Deliver only the generic reference integration in
`examples/rewards-optimizer/`. The actual Rewards Optimizer application,
database, review workflow, and deployment remain a separate project.

Implemented:

- a buildable public TypeScript example consuming only `@agent-feed/sdk`;
- authenticated caller scope (`tenant_id`, `consumer_id`, stream allowlist);
- protocol `0.1` validation and untrusted observation mapping;
- separate scoped transport receipts and versioned semantic keys;
- exact-retry idempotency with fail-closed event-ID payload conflict handling;
- evidence, hostile flags, restrictions, and unknown-attribute preservation;
- no promotion, database, SQL, Agent Feed server/private source, or Realtime
  dependency; and
- a no-skip Node-only architecture, behavioral, build, and package gate.

Gate:

- a generic finding maps to an untrusted observation, never a reward rule;
- transport and semantic identity remain separate across tenant, consumer, and
  stream scope;
- evidence and hostile/unknown data remain untrusted and non-promoted;
- lifecycle events create no observation and unauthorized streams fail closed;
- the built public package and packed artifact are usable; and
- all prior Agent Feed regressions and hosted CI remain green.

Production signed ingress, durable receipt-before-ACK, retries/dead letters,
canonical evidence, and review/promotion belong to downstream applications and
are not claimed by this reference milestone. See
`docs/14_milestone_4_reference_consumer.md` and `docs/m4/`.

## Milestone 5 — Portability and operations

Status: **M5A installability is accepted; the portability/operations reference
and contract slices are implemented and the no-skip combined local gate is
green, including live PostgreSQL and the PostgreSQL-compatible Supabase proof.
GitHub Actions run `32135239757` also passed the full M5 job. Hosted Supabase
proof remains an explicitly separate acceptance record.** See
`docs/16_milestone_5_portability_operations.md`.

Implemented in the first independently gated slice:

- private generated operator runtime and scoped producer credentials;
- localhost-only persistent PostgreSQL Compose option plus an external
  PostgreSQL credential-file option;
- protocol-clean launch of the existing MCP server;
- setup, doctor, and non-destructive PostgreSQL lifecycle commands;
- clean-checkout CI, adversarial guards, installation/upgrade documentation,
  and an explicit account-side handoff for ChatGPT Secure MCP Tunnel.
- a dependency-free SQLite lifecycle/liveness portability reference;
- a Supabase migration/security/Edge-relay reference whose canonical policy
  remains the Agent Feed API;
- pure retention planning and metadata-only deterministic audit export;
- an additive PostgreSQL operations adapter for managed external artifacts,
  bounded audit sources, and operational snapshots;
- bounded fixed-family observability/Prometheus rendering; and
- an optional read-only admin dashboard over a sanitized aggregate.

The local PostgreSQL-compatible proof applies the explicit
`0001 → 0002 → 0003 → 0004_operations` chain and runs the Supabase security,
RLS, health, liveness, and terminal-immutability fixture against a compatible
PostgreSQL engine. It proves checked-in SQL and role assumptions only; it does
not prove a hosted Supabase project, managed secrets, Edge deployment,
networking, backups, or rollback.

The full runner is `npm run m5:conformance` and requires
`AGENT_FEED_OPERATIONS_DATABASE_URL` (or `AGENT_FEED_DATABASE_URL`); it has no
live-database skip. The installability-only runner is
`npm run m5a:conformance`. Current package, live, and architecture counts are
recorded in the M5 completion document.

Retention candidates are limited to managed external artifacts; protocol and
delivery history remain protected. Metrics use fixed labels and durable state,
and Realtime may update a dashboard but is never the queue, lease,
acknowledgement, or recovery source of truth. Hosted Supabase receipts and
production deployment adapters are future acceptance work.

## Milestone 6 — Universal remote MCP

Status: **implementation, live PostgreSQL, full regression, and hosted CI
acceptance green; Claude account receipt waiting for eligible Owner or
individual Pro/Max access**. See
`docs/17_milestone_6_universal_remote_mcp.md` and `docs/m6/`.

Deliver:

- a separate Streamable HTTP composition over the existing official MCP
  server factory;
- request-scoped producer authentication with RFC 9728/RFC 8414 discovery;
- static Bearer support plus an optional operator-approved OAuth PKCE pilot;
- hard Host, Origin, streamed-body, error-redaction, and loopback boundaries;
- no changes to the three lifecycle tools or protocol `0.1`; and
- local, live PostgreSQL, hosted CI, and client-specific acceptance evidence.

Gate:

- HTTP and stdio discover the same three tools from one implementation;
- credentials never enter tool arguments and the authenticated principal is
  the only authority passed to `ProducerService`;
- a full remote begin/submit/complete lifecycle survives in PostgreSQL;
- OAuth codes are short-lived and one-use, PKCE is mandatory, refresh tokens
  rotate, and revoked tokens fail closed; and
- temporary tunnels and the embedded memory-only OAuth provider are not
  described as production hosting or production identity.

## Milestones 7–13 — Proof and control plane

The post-Milestone 6 roadmap is defined in
`docs/18_post_m6_roadmap.md`. Milestone 7 begins with occurrence-ledger and
liveness correctness. Later milestones add independent assessment receipts,
portable job definitions, a production control plane, provider conformance,
consumer utility feedback, and only then an evidence-based protocol `0.2`
decision. These capabilities are additive sidecars while protocol `0.1`
remains pinned.

### Milestone 7 — Occurrence ledger and liveness correctness

Status: **merged on `main` through PR #9 with live PostgreSQL, independent
re-review, full prior regression, and hosted CI green**. See
`docs/19_milestone_7_occurrence_ledger.md` and
`docs/m7/`.

Deliver:

- pure, deterministic interval and bounded five-field cron/timezone occurrence
  materialization;
- immutable, tenant-scoped schedule versions and expected occurrences;
- durable trusted trigger context outside protocol `0.1`;
- one-run/one-occurrence explicit, windowed, and legacy matching;
- separate absence, running, completed-zero, partial, failed, and cancelled
  liveness outcomes;
- bounded misfire and overlap decisions; and
- safe legacy-baseline migration with ambiguity quarantine.

Gate:

- nominal timestamps stay anchored when execution is delayed;
- only a trusted scheduled invocation can satisfy a normal occurrence;
- manual, test, replay, retry, backfill, event, and unknown invocations cannot
  move scheduled state;
- ambiguous or duplicate matches fail closed under concurrency;
- timezone/DST, misfire, and overlap fixtures pass with persisted occurrences;
- protocol `0.1` schemas and lifecycle tools remain unchanged; and
- the full prior milestone CI matrix remains green.

### Milestone 8 — Independent job proof and operational receipts

Status: **merged on `main` through PR #10 with local live acceptance,
independent hostile re-review, complete M0–M8 regression, and hosted CI
green**. See
`docs/20_milestone_8_job_proof.md` and `docs/m8/`.

Deliver:

- a pure assessment contract for policies, authority compatibility, typed
  outcomes, explicit telemetry, hashed artifact references, and canonical
  request identity;
- immutable, tenant-scoped policy and trusted assessor registration versions;
- immutable run assessment receipts with declared budget, observed usage, and
  artifact-reference children;
- exact idempotent retry and append-only same-run/same-policy reassessment;
- technical status derived from the persisted run and kept separate from the
  quality verdict; and
- a trusted composition-root boundary absent from producer REST and MCP.

Gate:

- producer self-checks cannot satisfy independent policies;
- caller-supplied authority or technical status fails closed;
- reassessment does not mutate the run or earlier receipt;
- unknown telemetry remains null and explicitly unknown;
- artifact references contain identity/provenance rather than blobs;
- protocol `0.1` schemas and lifecycle tools remain unchanged; and
- the complete prior milestone matrix remains green.

### Milestone 10 — Production control plane

Status: **payload-free contract, live tenant-scoped PostgreSQL projection, and
complete local M0–M10 regression green; dedicated hosted M10 gate added;
remaining production slices pending**. See
`docs/22_milestone_10_production_control_plane.md` and `docs/m10/`.

The first two checkpoints freeze tenant scope, freshness, an explicit
observation window, reconciled state groups,
completed-zero/absence separation, and distinct provider/gateway/execution/
validation/delivery failure layers in `packages/control-plane-core`, then
derive them through a bounded `REPEATABLE READ`, read-only adapter in
`packages/control-plane-postgres`. Dashboard integration, durable external
OIDC, hosted HTTPS, alerts, runbooks, independent review, and hosted acceptance
remain required before Milestone 10 can be called complete.

### Milestone 11 — Multi-provider conformance

Status: **first provider-neutral contract and synthetic adapter checkpoint
implemented locally; live provider and durable proof acceptance pending**. See
`docs/23_milestone_11_multi_provider_conformance.md` and `docs/m11/`.

The first checkpoint adds `packages/provider-conformance-core`, which compares
one exact logical-job definition and validation-policy version across distinct
deployment topologies. It reuses M8 telemetry and M9 ingress vocabularies,
requires complete terminal occurrence/execution/assessment/delivery proof, and
keeps unsupported telemetry explicitly null and unknown.

Executable fixtures cover the existing ChatGPT manual-export, Claude hook,
generic MCP, REST, and local-file/offline boundaries. These are synthetic
adapter-shape receipts: live ChatGPT Scheduled Tasks, a live Claude custom
connector, durable PostgreSQL receipt projection, provider-account evidence,
and hosted CI remain separate acceptance slices. Protocol `0.1`, producer REST,
and MCP lifecycle tools remain unchanged.

### Milestone 9 — Portable job registry and capability profiles

Status: **local live checkpoint and complete M0–M9 regression green;
independent review and hosted CI pending**. See
`docs/21_milestone_9_job_registry.md` and `docs/m9/`.

Deliver:

- immutable logical job-definition versions with owner, lifecycle,
  instruction digest/reference, policy, requirements, outputs, and budgets;
- immutable provider capability-profile versions;
- immutable deployment-binding versions with provider topology, exact profile
  pins, off-switch reference, and independently passed shadow evidence; and
- pure plus database-enforced activation preflight without external provider
  mutation.

Gate:

- one logical job preserves exact identity across provider moves;
- definitions contain no secrets or instruction bodies;
- incompatible exact-pinned capabilities fail before active registration;
- active autonomous bindings require owner, policy, budget, off-switch, and
  sealed independently passed shadow proof;
- protocol `0.1` and producer lifecycle tools remain unchanged; and
- the complete prior milestone matrix remains green.
