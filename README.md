# Agent Feed Foundation v0.1.1

Agent Feed is a standalone, reusable project for transmitting structured agent
runs, findings, and submitted evidence to multiple consumer applications.

Milestone 3 status: **local implementation gate green; hosted pull-request CI
pending**. The repository now includes an MCP server, TypeScript and Python
producer/consumer SDKs, REST/local-file/webhook/Claude/ChatGPT adapters,
capability-gated skills, and executable examples. Agent Feed wire protocol
remains `0.1`; the MCP transport uses the separate MCP revision `2026-07-28`
with tested legacy compatibility.

Milestone 2 status: **implementation gate complete in this repository**. The
corrected full acceptance is green: architecture 4, pure conformance 6, live
PostgreSQL 3, protocol-runtime 5, delivery-core 18, delivery-consumer 10,
persistence 11, webhook adapter 8, delivery worker 6, and delivery API 5.
All seven M2 packages/applications pass clean installs, builds, and tests.
M2-023 through M2-038 and M2-L027 through M2-L042 are resolved in the
append-only bug/learning logs. The
delivery API remains transport-neutral (there is no deployable HTTP server),
the worker has no production process/CLI entrypoint, and observability
exporter/deployment work remains future operational work. The migration loader
is intentionally explicit for `0001_agent_feed.sql`,
`0002_durable_delivery.sql`, then `0003_wire_run_id.sql`.

The repository CI workflow installs, builds, and tests all seven M2
packages/applications with live PostgreSQL. GitHub Actions CI run #5 passed on
draft PR #2 for commit `ad4ea3a`. The root runner serializes package tests so
persistence migrations cannot race.

It is intentionally separate from the Japan Rewards Optimizer. The two projects communicate through Agent Feed protocol `0.1`; neither project reads the other's database.

## Project layout

```text
packages/schema
packages/protocol-runtime
packages/delivery-core
packages/delivery-consumer
packages/webhook-adapter
packages/sdk/typescript
packages/sdk/python
packages/adapters
apps/mcp-server
apps/api
apps/delivery-api (transport-neutral handlers; no HTTP server)
apps/delivery-worker (composition foundation; no production entrypoint yet)
docs/adr
docs/m2
docs/operations
skills/chatgpt
skills/claude
examples/postgres
examples/supabase
examples/sqlite
examples/rewards-optimizer
examples/m3
```

## Trust boundary

A `Finding` means “a producer submitted this claim,” not “this is true.” Submitted evidence is not automatically canonical evidence. Consumer applications apply their own source authority, verification, retention, and domain rules.

## Runnable prototype

`prototype/` implements the thin run lifecycle, idempotency, terminal immutability, signed events, expected-cadence liveness, and hostile-finding preservation without external dependencies. Run `cd prototype && npm test`.

The M2 packages can be checked independently:

```sh
cd packages/protocol-runtime && npm test && npm run build
cd ../delivery-core && npm test && npm run build
cd ../delivery-consumer && npm test && npm run build
cd ../webhook-adapter && npm test && npm run build
cd ../persistence-postgres && npm test
cd ../.. && node --test tests/delivery/*.test.mjs
cd apps/delivery-worker && npm test && npm run build
cd ../delivery-api && npm test && npm run build
cd ../.. && node scripts/run_m2_conformance.mjs --allow-live-skip
```

The combined M2 gate uses clean package installs and a disposable PostgreSQL
database. `npm run m2:conformance` is the gate command and requires
`AGENT_FEED_DATABASE_URL`; `--allow-live-skip` is local-only and never counts
as acceptance. See `docs/12_milestone_2_delivery.md` for the evidence record
and remaining operational caveats.

The complete Milestone 3 gate has no skip mode and builds/tests the shared
producer service, API wrapper, MCP server, both SDKs, and every adapter:

```sh
npm run m3:conformance
```

Run the root foundation/protocol gates and live M1/M2 PostgreSQL gates as
documented in `docs/m3/ACCEPTANCE.md` before accepting a final commit.

## Durable producer ingress

Milestone 1's production-shaped producer path is `apps/api`, backed by
PostgreSQL through `@agent-feed/producer-service`. Run `npm run m1:architecture`
and `AGENT_FEED_DATABASE_URL=... npm run m1:ingress`; the latter is fail-closed
when no live database is configured. `packages/adapters/local-file` imports run
bundles through the same service boundary. See
`docs/m1-hardening/ACCEPTANCE.md` for the release evidence and published
immutable schema artifact. The Rewards Optimizer pin is owned by its separate
repository.

## Start implementation

Use `prompts/CODEX_INITIATING_PROMPT.md`, then the prompt for the milestone in
scope. Milestone 3 uses
`prompts/CODEX_MILESTONE_3_MCP_SDK_ADAPTERS_PROMPT.md`.

Read the relevant milestone record, the ADR index, and the operational runbook
before adding code. Milestone 3 decisions, bugs, learnings, and refactor-debt
review are append-only in `docs/m3/`.

## ChatGPT monitoring

ChatGPT monitoring tasks can serve as independent sentinels. Current Scheduled Tasks do not provide webhooks, so automatic production ingestion must use a tool-capable runtime or a separate API worker. The fallback is a validated run-bundle imported through `local-file`.

## Supabase

Recommended production deployment uses a separate Supabase project with Postgres, Edge Functions, Queues, scoped auth/RLS, optional Storage, and secrets. Realtime is optional for live dashboards and is never the delivery queue.
