# Agent Feed Foundation v0.1.1

Agent Feed is a standalone, reusable project for transmitting structured agent
runs, findings, and submitted evidence to multiple consumer applications.

Milestone 6 status: **authenticated Streamable HTTP, OAuth, live PostgreSQL,
and hosted CI acceptance are green; the Claude account receipt is waiting for
Owner or individual Pro/Max access**. The new
`apps/mcp-http` edge reuses the existing official MCP server factory and
therefore exposes exactly the same three lifecycle tools without copying
policy. Its embedded OAuth provider is a memory-only acceptance pilot, not a
production identity service. See
`docs/17_milestone_6_universal_remote_mcp.md`.

The approved post-Milestone 6 roadmap starts with schedule-occurrence and
liveness correctness, then layers independent job proof, portable definitions,
production operations, provider conformance, and utility feedback without
turning Agent Feed into a scheduler. See `docs/18_post_m6_roadmap.md`.

Milestone 5 status: **M5A installability is accepted and the combined local and
GitHub CI portability/operations gates are green, including live PostgreSQL;
hosted Supabase proof remains a separate production gate**. The operator CLI creates private
scoped runtime configuration, starts a localhost-only persistent PostgreSQL
profile, diagnoses the local boundary, and generates a protocol-clean command
for the existing MCP server. SQLite, Supabase, retention/audit, observability,
and dashboard boundaries are documented in
`docs/16_milestone_5_portability_operations.md`. A local PostgreSQL-compatible
Supabase run is not hosted production acceptance, and no command mutates OpenAI
account settings.

Milestone 4 status: **merged with generic reference-consumer local and hosted gates green**.
GitHub Actions run `32096064685` passed both the dedicated Node-only M4 job and
the full repository validation on PR #5. The buildable example maps protocol
`0.1` findings to scoped,
explicitly untrusted observations, separates transport and semantic identity,
preserves hostile/unknown evidence as data, and imports no Agent Feed server or
database internals. It does not implement the separate Rewards Optimizer app.

Milestone 3 status: **merged with hosted CI green**. GitHub Actions run
`32089258429` passed on PR #4; merge commit `60315f8` is on `main`. The
repository includes an MCP server, TypeScript and Python
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
apps/mcp-http (authenticated Streamable HTTP and optional OAuth PKCE pilot)
apps/api
apps/delivery-api (transport-neutral handlers; no HTTP server)
apps/delivery-worker (composition foundation; no production entrypoint yet)
packages/operations-core (pure retention/audit contracts)
packages/operations-observability (bounded metrics/Prometheus contract)
packages/operations-postgres (PostgreSQL operations adapter)
apps/admin-dashboard (optional read-only aggregate view)
docs/adr
docs/m2
docs/m5
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

## Install from GitHub

With Node.js 22+, Git, and Docker Compose installed:

```sh
git clone https://github.com/wesleykao1990/agent-feed.git
cd agent-feed
bin/agent-feed setup --stream monitoring.example
bin/agent-feed postgres up
bin/agent-feed doctor
```

Setup generates owner-only credentials under ignored `.runtime/`, never prints
secrets, binds PostgreSQL only to localhost, and preserves its named volume on
stop and upgrade. Existing PostgreSQL deployments can use an owner-only URL
file. See [the GitHub installation runbook](docs/operations/github-installation.md)
for external database, upgrade, and Secure MCP Tunnel handoff instructions.

The M5A focused clean-install gate is:

```sh
npm --prefix apps/mcp-server ci
npm run m5a:conformance
```

The full portability and operations gate is deliberately no-skip and requires
a disposable PostgreSQL URL:

```sh
npm run m5:conformance
```

It verifies the SQLite reference, Supabase static reference, operations-core,
operations-observability, operations-postgres, and admin-dashboard, then runs
the explicit PostgreSQL-compatible migration/Supabase proof when
`AGENT_FEED_OPERATIONS_DATABASE_URL` (or `AGENT_FEED_DATABASE_URL`) is set. See
the [Milestone 5 completion record](docs/16_milestone_5_portability_operations.md)
for the evidence ladder and remaining hosted gaps.

The foundation validator needs the Python packages declared in
`requirements-dev.txt`. A one-command managed invocation is:

```sh
uv run --with-requirements requirements-dev.txt python scripts/validate_package.py
```

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

The Milestone 4 gate is Node-only and deliberately has no PostgreSQL or
Rewards Optimizer dependency:

```sh
npm --prefix packages/sdk/typescript ci
npm --prefix examples/rewards-optimizer ci
npm run m4:conformance
```

It builds and imports the public artifact, runs zero-skip architecture and
behavioral suites, and performs a pack smoke check. See
`docs/14_milestone_4_reference_consumer.md` for its exact claims and limits.

## Durable producer ingress

Milestone 1's production-shaped producer path is `apps/api`, backed by
PostgreSQL through `@agent-feed/producer-service`. Run `npm run m1:architecture`
and `AGENT_FEED_DATABASE_URL=... npm run m1:ingress`; the latter is fail-closed
when no live database is configured. `packages/adapters/local-file` imports run
bundles through the same service boundary. See
`docs/m1-hardening/ACCEPTANCE.md` for the release evidence and published
immutable schema artifact. The Rewards Optimizer pin is owned by its separate
repository.

## Portability and operations

The SQLite directory is a dependency-free lifecycle/liveness reference, not a
replacement for PostgreSQL delivery. The Supabase directory copies canonical
migrations, adds private-schema/RLS/security checks, and provides an optional
Edge relay to the canonical API; it does not create or verify a hosted project.
Retention and audit are tenant-scoped and metadata-first, with immutable
protocol/delivery history protected. Metrics use fixed labels and durable
state. The dashboard is read-only, sanitized, and loopback-bound by default;
Realtime remains optional observation plumbing rather than a queue. The
package boundaries and no-refactor review are recorded alongside the exact
local-vs-hosted proof distinction in the completion record.

## Start implementation

Use `prompts/CODEX_INITIATING_PROMPT.md`, then the prompt for the milestone in
scope. Milestone 4 maintenance uses
`prompts/CODEX_MILESTONE_4_REFERENCE_CONSUMER_PROMPT.md`.

Read the relevant milestone record, the ADR index, and the operational runbook
before adding code. Milestone decisions, bugs, learnings, and refactor-debt
reviews are append-only in `docs/m3/`, `docs/m4/`, and `docs/m5/`.

## ChatGPT monitoring

ChatGPT monitoring tasks can submit automatically when the scheduled chat has
an installed Agent Feed plugin exposing all three MCP lifecycle tools. For a
private development deployment, the existing stdio MCP server can be connected
through OpenAI Secure MCP Tunnel; no public Agent Feed listener or second MCP
implementation is required. The task must fall back to a validated run-bundle
imported through `local-file` whenever the complete tool capability is absent.
See `docs/operations/chatgpt-scheduled-task.md`.

## Supabase

Recommended production deployment uses a separate Supabase project with
Postgres, Edge Functions, Queues, scoped auth/RLS, optional Storage, and
secrets. `node examples/supabase/tests/verify.mjs` is static only; the optional
PostgreSQL-compatible proof uses a local/disposable database and is not hosted
acceptance. Hosted claims require project-specific migration, health,
liveness, Edge, and rollback receipts. Realtime is optional for live
dashboards and is never the delivery queue.
