# SQLite portability reference

This directory is an executable, dependency-free SQLite reference for the
Agent Feed producer lifecycle. It demonstrates the same important acceptance
properties as the durable PostgreSQL producer boundary:

- begin-run, submit-batch, and complete-run lifecycle;
- canonical payload hashes and idempotent exact retries;
- payload-drift conflicts under reused idempotency keys;
- strictly increasing batch sequences;
- unique batch, finding, and evidence identities;
- evidence-reference resolution before a batch commits;
- completion-time and accepted-row count reconciliation;
- terminal-run immutability and append-only accepted rows;
- tenant-scoped reads; and
- stream expectations plus a durable liveness incident ledger for never-seen,
  overdue, and recovered streams.
- arbitrary producer-visible wire run IDs backed by a separate internal key.

All read and liveness methods require an explicit `tenant_id`. The example
does not provide an unscoped `getRun` or `listRuns` fallback, and stream
expectations/incidents use `(tenant_id, stream_id)` as their identity.

The reference is intentionally smaller than the production stack. It has no
HTTP server, authentication, outbox, delivery queue, worker, webhook,
distributed liveness scheduler/alerting, or Realtime integration. Its
liveness methods are a synchronous local expectation/incident ledger useful
for portability tests; they do not claim multi-process coordination. Use
PostgreSQL and the production delivery components for those capabilities.
See [`NOTES.md`](./NOTES.md) for compatibility assumptions and decisions.

## Run

Node.js `>=22.5` is required for the built-in `node:sqlite` API. From this
directory:

```sh
npm test
npm run demo
npm run verify
```

The package has no runtime or development dependencies, so a clean checkout
does not need an install step. The package scripts include
`--experimental-sqlite` for Node 22 compatibility; current Node releases also
accept the flag while exposing `DatabaseSync` directly.

The demo creates an in-memory database, accepts one evidence-only batch,
completes the run, and prints a compact JSON receipt. To use the adapter from
another local script:

```js
import { SqliteAgentFeedStore } from "./index.mjs";

const store = new SqliteAgentFeedStore({ filename: "./agent-feed.sqlite" });
try {
  const run = store.getRunForTenant("tenant.example", "run_wire_id");
  console.log(run?.status ?? "not found");
} finally {
  store.close();
}
```

The schema is applied on construction. A file-backed database should be
treated as a local example database; do not place production secrets or
untrusted payloads in it without applying the deployment's retention and
access controls.

The SQLite trigger on `runs` also guards direct SQL running-to-terminal
updates. It requires valid terminal envelope JSON, matching wire/stream/status/
time/scope fields, source-stat columns matching the envelope, and finding,
evidence, and batch counts matching accepted rows. The trigger is a defense in
depth check for the local reference; it cannot independently establish that a
producer's submitted provenance, task scope, source counts, or payload content
is truthful.

## Integration boundary

The exported `SqliteAgentFeedStore` is structurally compatible with the
producer persistence lifecycle (`beginRun`, `submitBatch`, `completeRun`,
`getRunForTenant`, and `checkReady`). `getRun(tenantId, runId)` and
`listRuns({ tenant_id })` are tenant-required convenience methods; callers
cannot accidentally fall back to a cross-tenant read. Liveness methods likewise
take a tenant first (`sweepOverdueStreams(tenantId, now)`). The source is
intentionally local rather than a new workspace package so the example remains
easy to copy and inspect.
The root M5 integration runs `npm --prefix examples/sqlite run verify` and keeps
this example separate from the PostgreSQL production adapter.
