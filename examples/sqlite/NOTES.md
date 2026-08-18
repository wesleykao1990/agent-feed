# SQLite reference notes

## Decisions

- This example uses Node's built-in `node:sqlite` `DatabaseSync` API. It has no
  npm runtime dependency and is intended for local/offline portability checks.
- The public adapter methods mirror the producer persistence lifecycle, but the
  implementation stays independent of PostgreSQL, HTTP, workers, and delivery
  transports. The PostgreSQL migration remains the production persistence
  source of truth.
- SQLite stores a generated internal UUID-like key separately from the
  producer-visible `wire_run_id`. This preserves arbitrary protocol run IDs and
  keeps the example aligned with the v0.4.1 wire-ID boundary.
- Each mutation runs in `BEGIN IMMEDIATE`/`COMMIT`; an unresolved reference or
  any invariant failure rolls back the complete batch. Accepted rows and
  terminal records are guarded by append-only triggers as well as application
  checks.
- Stream expectations and missed-run incidents are retained in a separate
  operational ledger. A terminal run advances `next_due_at`; a sweep creates
  one open missed-run receipt, and a later on-time run resolves it without
  deleting the incident. The sweep is local and synchronous, not a scheduler
  or distributed alerting service.
- Tenant scope is mandatory for `getRun`, `listRuns`, expectation reads, and
  liveness sweeps. Stream expectations and incidents use a composite
  `(tenant_id, stream_id)` identity, so equal stream names in two tenants never
  share due times or incident receipts.
- A database trigger checks that every `finding_evidence` link joins rows from
  the same internal run. SQLite foreign keys alone only prove that both rows
  exist, not that they share a trust boundary.
- The terminal-run trigger validates JSON syntax and checks envelope identity,
  status, timestamps, actual scope, source-stat columns, and accepted
  finding/evidence/batch counts before allowing a direct SQL completion. It
  allows only the recovery transition for liveness incidents; incident
  identity/details cannot be edited and incident rows cannot be deleted.
- The schema deliberately does not include an outbox, durable delivery queue,
  webhook attempts, leases, or Realtime. Those are PostgreSQL/delivery
  responsibilities and are not silently implied by this portability example.

## Compatibility assumptions

- Node.js `>=22.5` is required for `node:sqlite`; the package scripts pass the
  runtime's `--experimental-sqlite` flag for compatibility across Node 22 and
  current releases.
- The example stores protocol payloads as JSON text and compares timestamps by
  parsing ISO date-time strings in the adapter. It is a reference for lifecycle
  behavior, not a claim that SQLite timestamp or concurrency semantics equal
  PostgreSQL.
- File-backed restart durability is covered by the tests, but no backup,
  encryption, filesystem durability, multi-process locking, or disaster
  recovery guarantee is asserted.
- The tests run one process serially. SQLite's locking behavior under multiple
  application processes still needs an environment-specific deployment test.
- The database owner is trusted to keep this schema and its triggers installed.
  The database can enforce consistency between stored columns and accepted
  rows, but it cannot independently verify producer identity, trace IDs,
  task/source provenance, source-count meaning, or whether arbitrary payload
  text is truthful. The producer/service boundary remains responsible for
  authentication, protocol validation, and security policy.

## Learnings and follow-up

- `node:sqlite` is synchronous in the tested Node runtime, which makes a small
  dependency-free reference practical, but the application must not use this
  adapter as a drop-in replacement for the asynchronous PostgreSQL delivery
  stack.
- Parent integration should add the directory to the repository's M5
  architecture/conformance gate and root package documentation. This scoped
  change intentionally does not edit root manifests, CI, checksums, or shared
  roadmap documents.
