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
- capability-gated ChatGPT Scheduled Task export path.

Gate:

- REST and MCP call the same application service;
- an agent that cannot call tools can produce an importable run bundle;
- adapter failures close or preserve a partial run instead of silently disappearing.

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

Deliver Postgres, Supabase, and SQLite examples; retention and deletion; audit export; cost and backlog metrics; and an optional admin dashboard.

Realtime may update the dashboard, but the protocol and delivery remain fully functional without it.
