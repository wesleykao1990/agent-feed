# `@agent-feed/operations-postgres`

This package is the PostgreSQL operations adapter for Milestone 5. It owns
tenant-scoped retention planning, external-artifact lifecycle state, immutable
operations audit rows, a metadata-only audit source query, and bounded numeric
operational snapshots.

## Safety boundary

`managed_artifacts` is a registry of external storage references. The package
never deletes Agent Feed protocol or delivery rows. A retention job only changes
the registry status after an injected `ExternalArtifactAdapter` reports a
successful delete, tombstone, or already-absent result.

The adapter receives a high-entropy base64url confirmation token and a stable
per-item `operationId`. It must make the external operation idempotent: a retry
after a process crash must not create a second deletion side effect. The token
is passed only to the injected adapter; PostgreSQL stores only its SHA-256 hash
for exact-job confirmation checks, never the raw token.

External deletion is intentionally **at least once**, not exactly once. A claim
expires after a crashed or stalled worker, so another worker may repeat the
call with the same stable `operationId`. Provider adapters must persist or
otherwise enforce that idempotency key.

Storage references are opaque credential-free values. Provider references such
as `s3://bucket/path` and `vault:recovery/key` are accepted; URL userinfo,
queries, fragments, whitespace, and control characters are rejected. Provider
resolution belongs to the injected adapter.

Legal holds are checked while the managed-artifact row is locked immediately
before an external call. The migration trigger rejects changing a legal hold
while an item is `in_progress`. The database transaction commits before the
adapter call, so network I/O is never held inside a database transaction.

## Migration and integration

`migrations/0004_operations.sql` is additive and must be applied after the
existing `0001_agent_feed.sql`, `0002_durable_delivery.sql`, and
`0003_wire_run_id.sql` migrations. The root persistence loader and clean
PostgreSQL gate must explicitly load this file and verify its `0004_operations`
ledger entry. The package migration does not discover arbitrary files.

The current base schema's `stream_expectations.stream_id` is globally keyed,
not tenant keyed. Therefore snapshots return `liveness: null`; global liveness
aggregation belongs to a separate trusted metrics adapter until a dedicated
tenant-scoped liveness migration is approved.

`listAuditSources` returns deterministic, bounded, metadata-only rows from runs,
batches, findings/evidence metadata, outbox events, deliveries, attempts,
acknowledgements, acknowledgement commands, replays, and operations audit. It
does not return payload JSON, evidence excerpts, consumer receipts, URLs, or
raw error details. `mapAuditSourceForOperationsCore` removes any
`artifact*`/sensitive detail keys before a downstream operations-core export.

## Local verification

```sh
npm install
npm run build
npm test
```

The package tests use a recording/fake SQL contract and synthetic adapter; no
repository or user data is deleted. The root gate also runs the live acceptance
test against a dedicated disposable PostgreSQL database, including concurrent
worker claims, restart recovery, tenant constraints, and legal-hold races.
