# Supabase reference deployment

## Agent Feed project

Recommended optional deployment features (not required for the protocol or the
current local M2 foundation):

- Postgres: runs, findings, evidence metadata, outbox, subscriptions, and delivery state;
- Edge Functions: an optional narrow REST ingress relay is implemented as a
  reference under `examples/supabase/functions/producer-ingress`; the
  canonical API still owns authentication, protocol validation, and durable
  persistence;
- Queues/PGMQ: an optional queue adapter for durable internal work and
  retry/dead-letter processing; PostgreSQL delivery state remains authoritative;
- Auth/RLS or service-token authorization: tenant and stream isolation;
- Storage: optional large submitted artifacts;
- Vault/Function Secrets: signing keys and external credentials;
- Cron: optional retention cleanup, retry sweeps, and monitors hosted by Agent Feed;
- Realtime: optional admin dashboard only.

## Current evidence boundary

The executable reference has separate static and database-compatible checks:

- `node examples/supabase/tests/verify.mjs` checks migration parity, private
  schema/RLS markers, the bounded relay, and the checked-in documentation. It
  does not contact Supabase.
- `examples/supabase/tests/postgres.mjs`, when run with
  `AGENT_FEED_OPERATIONS_DATABASE_URL` (or `AGENT_FEED_DATABASE_URL`), applies
  the security fixture to a PostgreSQL-compatible database and checks
  no-login Supabase-role equivalents, RLS, the health RPC, liveness, and
  terminal immutability. This is local PostgreSQL compatibility evidence, not
  hosted Supabase acceptance.

Hosted production acceptance requires a user-owned project and a recorded
migration receipt, canonical API health response, liveness/immutability
result, optional Edge relay response, and reviewed rollback decision. No
repository command creates a project or claims those receipts. See
`docs/16_milestone_5_portability_operations.md` for the full proof ladder.

## Separate deployment

The production default is a separate Supabase project from each consumer. Cross-project delivery uses signed HTTPS events. A same-project prototype is allowed only if the public protocol remains the only integration boundary.

## No pgvector requirement

Vector search is not needed for protocol correctness. It may later assist operator search or duplicate suggestions but cannot replace consumer semantic dedupe or evidence policy.
