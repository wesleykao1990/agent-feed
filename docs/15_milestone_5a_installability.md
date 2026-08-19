# Milestone 5A — GitHub installability and private local operations

Status: the M5A installability slice has local, integrated, and hosted
pull-request evidence; its record is in `docs/m5/ACCEPTANCE.md`. The broader
Milestone 5 portability/operations continuation is recorded in
`docs/16_milestone_5_portability_operations.md`.

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
npm run m5a:conformance
```

The M5A runner has no PostgreSQL dependency because it is the clean-install,
static, and local-operator boundary. The full continuation uses
`npm run m5:conformance`, requires an explicit PostgreSQL URL, and has no live
database skip; see the M5 completion record for its proof ladder.

## Remaining Milestone 5 roadmap (M5A boundary and full-slice follow-ups)

The following reference/contract slices now exist and have their own local
evidence: SQLite lifecycle portability, Supabase migration/security reference,
pure retention and metadata-only audit export, PostgreSQL operations adapter,
bounded observability exporter, and optional read-only admin dashboard.

M5A must not be cited as evidence that those slices are hosted or production
operational. In particular, a local PostgreSQL-compatible Supabase proof is
not a hosted Supabase acceptance record. Hosted project receipts, tenant-scoped
liveness deployment, production artifact providers, metric sample providers,
dashboard authentication/deployment, SQLite multi-process/backup evidence, and
hosted Supabase receipts remain separate gaps.

See `docs/16_milestone_5_portability_operations.md` for the implementation
matrix, exact commands, modular dependency review, and current validation gaps.
