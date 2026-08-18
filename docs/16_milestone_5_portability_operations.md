# Milestone 5 — portability and operations completion record

Reviewed: 2026-08-18

Milestone 5A made a clean checkout installable. The remaining Milestone 5
slice adds local portability references and operational contracts without
changing Agent Feed wire protocol `0.1`, the existing producer service, or the
durable delivery source of truth. This record is deliberately split into
implementation evidence, a local PostgreSQL-compatible proof, and hosted
production evidence. Passing one column does not imply the others passed.

## Delivered scope

| Slice | Implementation boundary | Local evidence | Production claim |
|---|---|---|---|
| SQLite lifecycle reference | `examples/sqlite/` and its dependency-free `SqliteAgentFeedStore` | `npm --prefix examples/sqlite run verify`; 14 tests plus demo | Local/offline portability reference only. It has no authentication, outbox, delivery queue, worker, webhook, distributed scheduler, or Realtime path. |
| Supabase deployment reference | `examples/supabase/`; canonical migrations `0001`–`0003`, security migration `0004_supabase_security.sql`, and optional Edge relay | `node examples/supabase/tests/verify.mjs`; 12 static boundaries | No hosted project is created or verified by this repository. A user-owned project, credentials, migration receipt, health response, liveness result, and rollback record are required for hosted acceptance. |
| Pure operations contracts | `packages/operations-core` | Type-check plus 13 tests | No database or destructive side effect. Retention is dry-run by default; only explicitly managed external artifacts are candidates. |
| PostgreSQL operations adapter | `packages/operations-postgres` and `migrations/0004_operations.sql` | Type-check plus 8 unit tests and 1 live acceptance test in the disposable PostgreSQL gate | The adapter is production-shaped, not hosted deployment proof. The combined gate runs the explicit `0001 → 0002 → 0003 → 0004_operations` chain against a disposable database. |
| Observability contract | `packages/operations-observability` | Type-check plus 9 tests | This is a bounded snapshot/Prometheus library. It does not open a database, expose an HTTP endpoint, or use Realtime as a queue. A deployment adapter still owns aggregation, auth, caching, and scrape availability. |
| Admin dashboard reference | `apps/admin-dashboard` | Type-check plus 7 tests | Read-only local presentation over a sanitized aggregate. It binds to loopback by default; production auth, TLS, network policy, deployment, and alerting remain external. |

The repository-level runner is `npm run m5:conformance`. It intentionally has
no live-database skip: without
`AGENT_FEED_OPERATIONS_DATABASE_URL` (or `AGENT_FEED_DATABASE_URL`) it reports
the gate incomplete. With a disposable local PostgreSQL URL, the green gate
applies the explicit migration chain, builds and tests the operations
packages/dashboard, and runs the PostgreSQL-compatible Supabase proof. The
installability-only command remains `npm run m5a:conformance`.

## Supabase proof boundary

The Supabase reference has two distinct checks:

1. The static check compares the copied canonical migration files byte for
   byte, checks the private-schema/RLS/security markers, and checks the narrow
   Edge relay. It does not contact Supabase.
2. The PostgreSQL-compatible proof runs
   `examples/supabase/tests/postgres.mjs` against a PostgreSQL database after
   the explicit Agent Feed and operations migrations are applied. It creates
   no-login equivalents of Supabase's `anon`, `authenticated`, and
   `service_role` roles, then checks role privileges, RLS, the health RPC,
   liveness, and terminal immutability. This proves that the checked-in SQL
   and privilege assumptions work on a compatible local PostgreSQL engine; it
   is not a hosted Supabase proof.

Hosted acceptance requires an operator to use a separate Supabase project and
record, at minimum:

- the project/ref and reviewed migration receipt;
- the canonical API health response using the server-side database URL;
- the liveness and terminal-immutability fixture result;
- the Edge relay response, if the optional relay is deployed; and
- the reviewed rollback/forward-migration decision.

No Supabase credentials, account settings, or hosted project are part of the
repository acceptance record. Realtime remains optional dashboard plumbing and
never becomes the queue, lease, acknowledgement, or recovery mechanism.

## Retention, audit, and metrics safety claims

- `operations-core` accepts metadata, not raw finding/evidence payloads. It
  produces bounded, deterministic retention plans and metadata-only NDJSON
  exports with content hashes. The plan cap is 500 candidates; audit exports
  are capped at 1,000 records and 1 MiB.
- Protocol runs, batches, findings, submitted evidence, outbox events,
  deliveries, attempts, and liveness incidents remain protected history.
  `managed_artifact` is the only deletion candidate in this slice. External
  deletion/tombstoning is injected, confirmation-token based, and at-least-once
  with a stable adapter idempotency key;
  PostgreSQL does not hold a transaction open across provider I/O.
- The PostgreSQL adapter does not infer tenant-scoped liveness from the
  current globally keyed stream-expectation tables. Its operations snapshot
  therefore reports `liveness: null` until a dedicated tenant-scoped schema
  migration and trusted adapter are approved.
- Observability emits a fixed, bounded family set with fixed enum labels. A
  persistence adapter must aggregate tenant/consumer/subscription dimensions
  before crossing the exporter boundary and must retain the last good sample
  when refresh fails.
- The dashboard consumes only the versioned aggregate, escapes dynamic values,
  exposes no mutation route, and rejects credential-shaped query strings.

## Modular dependency and no-refactor review

The modules were reviewed as separate contracts and no cross-package refactor
is required for this slice:

| Boundary | Allowed dependency | Deliberately excluded |
|---|---|---|
| `examples/sqlite` | Node built-ins, local schema/store files | PostgreSQL driver, Agent Feed API, delivery worker, Realtime, shared mutable persistence internals |
| `examples/supabase` | Supabase/Deno runtime at deployment; canonical API via an HTTPS URL | A second producer policy, direct browser database access, Realtime queueing |
| `operations-core` | Node `crypto` and its own pure contracts | SQL, `pg`, HTTP, queue, worker, provider credentials, consumer internals |
| `operations-postgres` | Node built-ins and `pg`; its additive migration | Protocol-row deletion, provider credentials, external network I/O inside a DB transaction, false tenant-liveness claims |
| `operations-observability` | Its fixed types and renderer | Database connections, HTTP server, arbitrary labels, raw errors/source content |
| `admin-dashboard` | Node HTTP/filesystem plus the observability package's public snapshot contract | SQL, queue mutation, Realtime dependency, browser credentials, source payload rendering |

The composition order is intentionally one-way: storage adapters produce
bounded metadata/snapshots; pure operations and observability contracts validate
them; the dashboard presents a smaller read-only view. The root M5 runner
orchestrates checks but is not a runtime dependency. No module imports the
operator CLI, dashboard, or Supabase relay into the canonical producer or
delivery path.

The current follow-up items are deployment requirements, not reasons to merge
these boundaries: a tenant-scoped liveness migration, a real metrics sample
provider/cache, production dashboard auth/deployment, provider-specific
artifact cleanup, SQLite multi-process/backup testing, and hosted Supabase
evidence. They should be addressed with new acceptance slices rather than by
merging the pure contracts into a database or UI package.

## Validation record for this checkout

Passed locally:

- `node scripts/check_m5_architecture.mjs` — 8 installability boundaries;
- `node scripts/check_m5_operations_architecture.mjs` — 7 portability/
  operations boundaries;
- `npm --prefix examples/sqlite run verify` — 14/14 tests and demo;
- `node examples/supabase/tests/verify.mjs` — 12 static boundaries;
- operations-core — build plus 13/13 tests;
- operations-observability — build plus 9/9 tests;
- operations-postgres — build plus 9/9 tests, including the live acceptance;
- admin-dashboard — build plus 7/7 tests.

The first operations architecture run found three marker mismatches; the
checker/implementation names were aligned during this review and the rerun
passed 7/7. The no-skip full M5 gate is now green against a disposable local
PostgreSQL database, including the Supabase-compatible roles/RLS/health/
liveness/immutability proof. Hosted Supabase proof remains open even after
that local gate is green.

Supporting records: `docs/15_milestone_5a_installability.md`,
`docs/m5/ACCEPTANCE.md`, `docs/m5/DECISIONS.md`, `docs/m5/BUGS.md`,
`docs/m5/LEARNINGS.md`, `docs/m5/REFACTOR_DEBT.md`, and the package-local
decision/bug/learning records under the new M5 modules.
