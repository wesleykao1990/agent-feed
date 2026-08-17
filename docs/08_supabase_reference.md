# Supabase reference deployment

## Agent Feed project

Recommended optional deployment features (not required for the protocol or the
current local M2 foundation):

- Postgres: runs, findings, evidence metadata, outbox, subscriptions, and delivery state;
- Edge Functions: a possible REST/MCP ingress, signed webhook delivery, and
  consumer callback adapter; no Edge Function is implemented in this repo;
- Queues/PGMQ: an optional queue adapter for durable internal work and
  retry/dead-letter processing; PostgreSQL delivery state remains authoritative;
- Auth/RLS or service-token authorization: tenant and stream isolation;
- Storage: optional large submitted artifacts;
- Vault/Function Secrets: signing keys and external credentials;
- Cron: optional retention cleanup, retry sweeps, and monitors hosted by Agent Feed;
- Realtime: optional admin dashboard only.

## Separate deployment

The production default is a separate Supabase project from each consumer. Cross-project delivery uses signed HTTPS events. A same-project prototype is allowed only if the public protocol remains the only integration boundary.

## No pgvector requirement

Vector search is not needed for protocol correctness. It may later assist operator search or duplicate suggestions but cannot replace consumer semantic dedupe or evidence policy.
