# Milestone 2 bug and gap log

Status: **open items carried into implementation**

This is an append-only log. Do not silently rewrite an entry when a fix lands.
Append a resolution note with the commit, regression test, and validation date.

| ID | Symptom / evidence | Impact | Planned fix | Regression test | Status |
|---|---|---|---|---|---|
| M2-001 | `agent_feed.outbox_events.delivered_at` in `packages/persistence-postgres/migrations/0001_agent_feed.sql` is one global delivery marker. | The first successful consumer could make an event appear delivered to every other consumer. | Add per-subscription attempt/ack state in `0002_durable_delivery.sql`; never use the global column as acknowledgement truth. | Two consumers receive the same event; one succeeds while the other remains pending/retryable. | Open — design recorded in ADR-0002 |
| M2-002 | `prototype/src/events.ts` and `prototype/src/types.ts` use camelCase event fields, while `packages/schema/contracts/delivery-event.schema.json` is strict snake_case. | Signing or validating the wrong representation can produce a signature that is not the protocol wire body. | Add one snake_case wire conversion before signing; keep protocol `0.1` body unchanged. | Sign a converted event, validate the exact raw body with AJV, then reject a camelCase/altered body. | Open — design recorded in ADR-0005 |
| M2-003 | Canonical JSON exists in `prototype/src/wire.ts`, `prototype/src/security.ts`, and `packages/persistence-postgres/src/hash.ts`. | Different undefined/number/object handling can cause idempotency hashes and signatures to diverge. | Extract one `packages/protocol-runtime` canonicalizer and make existing callers delegate. | Cross-package corpus produces byte-identical canonical JSON and hashes. | Open — design recorded in ADR-0001/0005 |
| M2-004 | `0001_agent_feed.sql` reserves `outbox_events`, but `PostgresAgentFeedPersistence.submitBatch` and `completeRun` do not enqueue durable events. | Accepted findings can exist without a recoverable delivery record. | Add a transaction-aware outbox writer and invoke it before the existing ingress transaction commits. | Failed batch rolls back findings/evidence/outbox; exact retry creates no duplicate outbox rows; terminal event appears once. | Open — design recorded in ADR-0002 |
| M2-005 | M1 tables and repository methods have no consumer/tenant/subscription authorization scope. | A delivery query or replay endpoint could expose another consumer's feed. | Scope subscriptions, attempts, acks, cursors, dead letters, and service methods by authenticated consumer/tenant principal. | Consumer A cannot list, claim, pull, ack, or replay Consumer B's event even with guessed IDs. | Open — design recorded in ADR-0004 |
| M2-006 | `MIGRATION_SQL_URL` in `packages/persistence-postgres/src/postgres-store.ts` points only to `0001_agent_feed.sql`. | A deployed M2 service cannot reliably apply the new durable-delivery schema. | Add ordered migration discovery/checking and test clean plus existing-M1 upgrades. | Migration runner applies 0001 then 0002 idempotently and rejects gaps/out-of-order files. | Open — implementation required before M2 operational use |
| M2-007 | `prototype/src/store.ts` computes a batch idempotency hash from `{ findings, evidence }` only. `batchId`, `idempotencyKey`, and other request fields are outside that hash. | A changed batch identity or request metadata can be treated as the same payload under an idempotency key, weakening conflict detection. | Define the complete canonical idempotency payload and align the prototype with the durable service boundary. | Reusing a batch key with changed batch identity/request fields is rejected; exact retries remain idempotent. | Open — implementation and regression test required |

## Resolution-note format

Append entries in this form when an item is fixed:

```text
Resolution: M2-000 (YYYY-MM-DD)
Fix commit/PR: <hash or link>
Regression evidence: <test command and result>
Residual risk: <none or explicit follow-up>
```
