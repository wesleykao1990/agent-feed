# `@agent-feed/operations-core`

Pure operational primitives for the Agent Feed Milestone 5 lifecycle slice.
The package has no database, HTTP, queue, or consumer dependency. It gives a
PostgreSQL, Supabase, or SQLite worker the same reviewable contracts for:

- tenant-scoped retention planning;
- fail-closed legal-hold and running-record handling;
- dry-run and adapter-mediated deletion;
- deterministic metadata-only NDJSON audit exports.

Only `managed_artifact` records can become deletion candidates. Runs, batches,
findings, submitted evidence, outbox events, delivery rows, and liveness
incidents are protected history and are returned as explicit
`protected_entity` skips. This package does not provide a back door around
the append-only database triggers.

## Retention

An operator first resolves metadata through its store adapter and calls
`planRetention`. The returned `agent-feed.retention-plan.v1` object contains a
stable SHA-256 `planId`, sorted deletion candidates, and explicit skip reasons.
The default execution mode is dry-run:

```ts
const plan = await planRetentionFromStore(store, {
  now: new Date().toISOString(),
  scope: { tenantId: "tenant-a", streamIds: ["scheduled-task.daily"] },
  policy: {
    policyVersion: "retention-2026-01",
    defaultRule: { ageSeconds: 90 * 24 * 60 * 60, requireTerminal: false },
  },
});

const preview = await executeRetentionPlan(store, plan); // dry-run
const applied = await executeRetentionPlan(store, plan, { dryRun: false });
```

`RetentionStore.deleteRecords` is an explicit integration boundary. The
adapter must re-check the tenant, plan ID, legal holds, object-storage
dependency ordering, and current eligibility inside one transaction. This
package never issues SQL and never mutates consumer delivery state implicitly.
The maximum plan size is 500 candidates; larger jobs must paginate into
separately reviewed plans. Planning and execution both reject over-limit
input; overflow is never silently converted into a skipped record. Execution
also recomputes the plan fingerprint before calling the adapter, so changing a
candidate under an old plan ID fails closed.

The package requires a tenant ID for every operation. A caller may narrow a
plan by run, stream, or entity; it cannot request an all-tenant plan.

## Audit export

`exportAudit` accepts immutable audit metadata only. It emits canonical
`agent-feed.audit-export.v1` NDJSON sorted by timestamp, record type, and
record ID, plus a SHA-256 hash of the exact bytes. Raw finding/evidence
payloads are not part of the input type, which avoids turning an operator
export into an accidental data exfiltration path.

The resulting bytes are stable for the same records and scope, so a caller
can persist the content-addressed export and record its hash in an external
audit ledger. Exports are bounded to 1,000 records and 1 MiB of UTF-8 NDJSON;
callers should paginate larger audit windows. Nested metadata keys containing
payload, body, content, raw, excerpt, token, secret, authorization, cookie,
credential, password, signature, or artifact are rejected. Values are also
scanned for Bearer/Basic credentials, URL user information, sensitive signed
URL query parameters, JWT-shaped values, and recognizable provider API-key
formats. Records that tie on timestamp/type/ID/action use their canonical
normalized bytes as the final ordering key, so input order cannot change the
export hash.

## Scope of this package

This is the pure contract layer. A follow-up adapter package should provide
PostgreSQL/Supabase/SQLite queries, transactional deletion ordering, object
storage cleanup, authorization, and scheduling. Those adapters must preserve
the tenant/run boundaries and immutable delivery/audit guarantees described
by the package-local decisions and learnings.
