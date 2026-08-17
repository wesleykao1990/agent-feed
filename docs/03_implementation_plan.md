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

Deliver:

- separate agent-feed database/schema;
- idempotent `begin`, `submit batch`, and `complete` services;
- immutable findings/evidence and append-only run events;
- producer authentication and stream-scoped authorization;
- size/rate limits, payload hashing, and PII/secret rejection hooks;
- REST endpoints and local-file run-bundle importer.

Gate:

- repeating an idempotency key returns the original result without duplicate rows;
- completing a run twice is deterministic and cannot change its terminal state;
- partial and failed runs preserve actual scope and errors;
- zero-finding completed runs are queryable;
- expected streams that miss a terminal run become overdue;
- terminal runs and accepted batches/findings/evidence are immutable;
- hostile findings retain security flags and are eligible for quarantine.

## Initial build constraint

Before the Rewards conserved kernel and monitoring rehearsal are working, implement only the minimal generic surface: protocol, persistence, local-file import, one REST path, liveness, and signed event generation. Defer Python SDK, generic webhook, Claude hook, polished MCP deployment, admin dashboard, and a separate production Supabase project until a second consumer or measured volume justifies them. The project remains separate in source and contract even when local development uses one temporary database.

## Milestone 2 — Durable consumer delivery

Status: **implementation gate complete in this repository**. The corrected
full acceptance is green: architecture 4, pure conformance 6, live PostgreSQL
3, protocol-runtime 5, delivery-core 18, delivery-consumer 10,
persistence-postgres 10, webhook adapter 8, delivery-worker 6, and
delivery-api 5. All seven M2 packages/applications pass clean installs,
builds, and tests; M2-023 through M2-038 and M2-L027 through M2-L042 are
resolved in the append-only bug/learning logs. The repository workflow is configured to install/build/test
all seven and require live PostgreSQL. Hosted GitHub Actions CI run #5 passed
on draft PR #2 for commit `ad4ea3a`.
The API remains transport-neutral without an HTTP server; worker process
deployment and observability export remain future operational work. Migration
loading is intentionally explicit `0001` followed by `0002`, not arbitrary
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

## Milestone 3 — MCP, SDKs, and adapters

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

Deliver only the generic reference integration in `examples/rewards-optimizer/`. The actual consumer implementation lives in the separate Rewards Optimizer project.

Gate:

- a generic finding maps to an untrusted source observation, not a reward rule;
- transport dedupe and reward-domain semantic dedupe remain separate;
- submitted evidence is not promoted automatically;
- no direct database access exists between projects.

## Milestone 5 — Portability and operations

Deliver Postgres, Supabase, and SQLite examples; retention and deletion; audit export; cost and backlog metrics; and an optional admin dashboard.

Realtime may update the dashboard, but the protocol and delivery remain fully functional without it.
