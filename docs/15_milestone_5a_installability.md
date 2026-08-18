# Milestone 5A — GitHub installability and private local operations

Status: local implementation and integrated regressions green; hosted
pull-request acceptance evidence pending in `docs/m5/ACCEPTANCE.md`

Milestone 5 is broader than installation. This first slice makes the accepted
PostgreSQL/MCP implementation usable from a clean GitHub checkout without
changing protocol `0.1` or taking ownership of OpenAI account operations.

## Delivered scope

- one root `bin/agent-feed` operator command;
- private, generated runtime configuration and scoped producer credentials;
- bundled localhost-only PostgreSQL 16 Compose profile with a persistent named
  volume;
- an existing-PostgreSQL option using an owner-only credential file;
- a protocol-clean MCP launcher that directly starts the existing shared MCP
  server and scrubs competing ambient credentials;
- `setup`, `doctor`, and non-destructive `postgres up|stop|status` commands;
- clean-checkout Node 22 CI and adversarial architecture/operator tests; and
- a GitHub installation/upgrade/ChatGPT handoff runbook.

## Explicit boundaries

This slice does not create OpenAI tunnels, runtime keys, plugins, Developer Mode
settings, or Scheduled Tasks. It does not expose PostgreSQL publicly, provide a
database deletion command, implement a second MCP server, or implement the
separate Rewards Optimizer.

The `doctor` command is diagnostic. It verifies the configured database socket,
not database authentication or full lifecycle semantics. MCP startup performs
the existing migrations, while prior live M1/M2 gates remain the semantic and
durability proof.

## Gate

```sh
npm --prefix apps/mcp-server ci
npm run m5:conformance
```

The M5A runner has no PostgreSQL skip because it is a clean-install/static and
local-operator boundary. Live PostgreSQL behavior continues to run in the
repository's existing integrated validation job.

## Remaining Milestone 5 roadmap

- production Supabase deployment example and operational proof;
- SQLite portability example;
- retention/deletion policy and jobs;
- audit export;
- cost, backlog, and liveness metrics/exporters; and
- optional admin dashboard with Realtime remaining optional.

These are separate acceptance slices. M5A must not be cited as evidence that
they exist.
