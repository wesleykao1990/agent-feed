# PostgreSQL persistence boundary

`@agent-feed/persistence-postgres` is the bounded Milestone 1 persistence slice
for the generic Agent Feed protocol. It owns the `agent_feed` schema and keeps
the database separate from consumer/domain tables and from the prototype HTTP
and security code.

The `PostgresAgentFeedPersistence` service provides:

- idempotent `beginRun`, with a canonical payload hash and conflict detection;
- transaction-locked, atomic `submitBatch`, including increasing sequences,
  evidence-reference resolution, and immutable accepted rows;
- terminal/idempotent `completeRun`, with completion-time, scope, and accepted
  count reconciliation;
- queryable runs (including completed zero-finding runs);
- persisted stream expectations and an overdue-run sweep;
- immutable terminal runs enforced by database triggers.

The migration includes a reserved `outbox_events` table for compatibility with
the reference schema, but this package never writes or delivers outbox events.
Durable delivery, subscriptions, retries, acknowledgements, signatures, and
workers are Milestone 2 and intentionally remain outside this boundary.

## Test

From this directory:

```sh
npm install
npm run build
npm test
```

`npm test` always runs structural/unit tests. Set
`AGENT_FEED_DATABASE_URL` to run the live PostgreSQL regression tests as well;
the live suite uses unique fixture IDs in the `agent_feed` schema. Use a
disposable test database when running it repeatedly. The package does not
start or stop a database server.
