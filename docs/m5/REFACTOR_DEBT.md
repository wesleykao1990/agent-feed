# Milestone 5 modularity and refactor-debt audit

Reviewed: 2026-08-23

## Boundaries

| Module | Owns | Must not own |
|---|---|---|
| `bin/agent-feed` | Executable entrypoint and exit status | Setup policy, credentials, MCP implementation |
| `apps/operator-cli/src/main.mjs` | Argument mapping and human-safe output | Database/MCP internals or account mutation |
| `apps/operator-cli/src/config.mjs` | Pure config validation, secret generation, and credential-free renderers | Filesystem, subprocess, database, or account mutation |
| `apps/operator-cli/src/operator.mjs` | Local runtime files, Compose invocation, doctor, MCP process composition | Protocol lifecycle policy, config grammar, or tunnel credentials |
| `apps/mcp-server` | Existing stdio MCP and shared producer service composition | Operator UX or a second credential store |
| `compose.yaml` | Private local PostgreSQL convenience | Production deployment or data deletion |

## Review result

- [x] Operator code uses Node built-ins only and has no package runtime
  dependency.
- [x] The root executable is a thin entrypoint; behavior remains directly
  testable.
- [x] Pure validation/rendering is separate from filesystem and process
  orchestration; the compatibility re-export avoids duplicate public surfaces.
- [x] The generated launcher contains only absolute paths and invokes the
  existing MCP implementation.
- [x] Runtime state is ignored, owner-only, contained, and symlink-safe.
- [x] Docker actions expose only `up`, `stop`, and `status`; no volume removal
  path exists.
- [x] Account-side tunnel and ChatGPT operations remain outside the module.
- [x] Tunnel liveness probing composes the official client and validates its
  structured result without owning tunnel credentials or control-plane state.
- [x] Static and behavioral gates are separate and wired to clean-checkout CI.

## Deferred work, not immediate refactor debt

Windows launcher support requires a platform-specific wrapper because this
slice emits a POSIX shell file. A deeper doctor could authenticate, inspect the
migration ledger, and run a reversible lifecycle probe, but it must use a
dedicated diagnostic identity and avoid mutating production streams. Neither
justifies splitting the current small operator module before those requirements
exist.

## Portability and operations boundary review

The remaining Milestone 5 modules were reviewed as independent contracts. The
dependency direction is intentionally one-way: adapters produce bounded
metadata/snapshots, pure packages validate policy and exposition, and the
dashboard renders a smaller read-only aggregate.

| Module | Owns | Allowed dependency | Must not own |
|---|---|---|---|
| `examples/sqlite` | Copyable lifecycle/liveness reference and local schema | Node built-ins and local example files | PostgreSQL/HTTP/delivery internals, credentials, Realtime, or a production durability claim |
| `examples/supabase` | Migration-parity/security reference and optional narrow relay | Supabase/Deno runtime and the canonical API HTTPS URL | A second producer policy, direct browser database access, or Realtime queueing |
| `packages/operations-core` | Pure retention plans and metadata-only canonical audit export | Node `crypto` and package-local contracts | SQL, `pg`, HTTP, queues, provider credentials, or consumer state |
| `packages/operations-postgres` | Additive PostgreSQL operations migration, artifact jobs, audit sources, and bounded snapshots | Node built-ins and `pg`; injected external-artifact adapter | Protocol/delivery row deletion, provider I/O inside a transaction, or false tenant-liveness isolation |
| `packages/operations-observability` | Fixed metric families, bounded collection, and Prometheus rendering | Package-local types and fixed enum vocabularies | Database connections, HTTP serving, arbitrary labels, raw errors, or Realtime as truth |
| `apps/admin-dashboard` | Sanitized read-only HTML/API view and snapshot mapping | Node HTTP/filesystem and the observability package's public snapshot | SQL, queue mutation, browser credentials, source payloads, or mandatory Realtime |
| M5 root runner | Explicit static, package, and live-proof orchestration | Existing package commands and an explicitly supplied database URL | Hidden migration discovery, silent live-test skips, or runtime ownership of any module |

### No-refactor review result

- [x] The pure operations contract is independently testable and has no
  runtime database dependency.
- [x] The PostgreSQL adapter owns SQL and transaction ordering without making
  the pure package or dashboard import database internals.
- [x] The observability package exposes fixed families and bounded labels;
  dashboard mapping validates the complete snapshot before selecting cards.
- [x] SQLite and Supabase remain examples/references rather than alternate
  production ingress implementations.
- [x] The dashboard has no mutation route and does not become a queue or
  Realtime source of truth.
- [x] No package extraction, merge, or shared “utility” refactor is justified
  by the current surface; future work can add an adapter only when a real
  deployment needs it.

The following are deferred deployment/acceptance work, not reasons to collapse
the boundaries above: tenant-scoped liveness schema and provider, a real
metrics sample provider with last-good caching, production dashboard
authentication/TLS/deployment, provider-specific managed-artifact cleanup,
SQLite multi-process/backup testing, and hosted Supabase receipts. The initial
operations architecture marker mismatch is tracked as resolved in
`docs/m5/BUGS.md`; the no-skip full gate passed using a disposable database,
and the hosted Supabase boundary remains open.
