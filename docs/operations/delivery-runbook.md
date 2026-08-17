# Durable delivery runbook

Status: **in progress — preparatory runbook; M2 worker/API are not yet
implemented**

This runbook is the target operating procedure. Commands and endpoints are
marked as implemented only after they exist in the repository and pass CI.

## Preflight

Before changing the delivery deployment:

1. Confirm the branch is clean and the intended commit is identified.
2. Run the M1 gates from the repository root:

   ```sh
   python scripts/generate_checksums.py --check
   python scripts/generate_protocol_types.py --check
   python scripts/check_protocol_compatibility.py
   python scripts/validate_package.py
   npm run conformance:test
   cd prototype && npm test
   ```

3. Confirm a disposable PostgreSQL database is available for migration and
   delivery tests.
4. Confirm producer and consumer credentials are available through the secret
   manager, never in source or logs.
5. Confirm the configured signing key ID, replay window, retry limit, lease
   duration, and dead-letter policy match the current ADRs.

The M2 worker, migration runner, and delivery API are not present at the time
of this document. Do not execute an unbuilt command from this runbook in a
production environment.

## Migration procedure

When `0002_durable_delivery.sql` and the migration runner land:

1. Take a schema backup or verify the recovery point.
2. Run the ordered migration runner in a maintenance window appropriate for
   the deployment.
3. Verify the migration ledger contains `0001` and `0002` exactly once.
4. Verify the outbox, subscriptions, attempts, acknowledgements, dead-letter,
   and cursor indexes exist.
5. Run a transaction rollback fixture and an exact idempotency retry fixture.
6. Only then start workers.

The current M1 loader only reads `0001_agent_feed.sql`; this procedure is
blocked until M2 migration discovery is implemented. See M2-006 in the bug log.

## Worker startup and shutdown

Target startup checks:

- database connectivity and migration version;
- signing-key availability and key ID;
- consumer webhook allowlist/TLS policy;
- lease duration and retry configuration;
- metrics exporter health;
- no stale worker lease exceeds the recovery policy.

Workers should stop claiming new work on `SIGTERM`, finish or release the
current lease within the shutdown deadline, and leave expired work reclaimable.
The actual command and environment variable names must be added here with the
worker implementation; do not invent them in deployment automation first.

## Routine monitoring

Inspect, at minimum:

- pending queue depth and oldest pending age;
- attempts by status and retry count;
- lease age and expired leases;
- webhook latency and status-code class;
- acknowledgement latency;
- dead-letter count and replay count;
- signature/replay/authentication failures;
- consumer-specific backlog and error rate.

Never log raw finding summaries, evidence excerpts, authorization headers,
signing secrets, or full webhook bodies. Correlate with event ID/trace ID and a
redacted error class.

## Consumer outage recovery

1. Identify the affected consumer/subscription and oldest pending event.
2. Confirm Agent Feed outbox rows remain present and immutable.
3. Confirm attempts are retrying or held by leases, not globally marked
   delivered.
4. Validate the consumer's receipt endpoint and signing-key configuration.
5. Allow bounded retries to resume; do not change producer idempotency keys.
6. Compare consumer receipt IDs with Agent Feed event IDs after recovery.
7. Record any manual action in the bug/incident log.

## Dead-letter handling

Use `docs/operations/dead-letter-replay.md`. Operators must inspect the last
error, consumer scope, signature key ID, event sensitivity, and attempt history
before replay. Replay is never a delete or an event mutation.

## Key rotation

The target rotation procedure keeps the old key available for the documented
overlap period, publishes the new key ID to the worker, sends new attempts with
the new key, and verifies both keys during the overlap. Retire the old key only
after all in-flight attempt TTLs and replay windows have elapsed.

## Rollback and incident evidence

Do not roll back by deleting outbox or delivery state. Stop workers, preserve
immutable events and attempt history, and deploy a forward-compatible fix or
disable only the affected subscription. Capture:

- deployment commit;
- migration version;
- consumer/subscription scope;
- event/trace IDs;
- attempt and lease history;
- redacted errors and metric snapshots;
- operator decision and follow-up bug ID.
