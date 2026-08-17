# Supabase reference deployment

## Agent Feed project

Recommended features:

- Postgres: runs, findings, evidence metadata, outbox, subscriptions, and delivery state;
- Edge Functions: REST/MCP ingress, signed webhook delivery, and consumer callbacks;
- Queues/PGMQ: durable internal work and retry/dead-letter processing;
- Auth/RLS or service-token authorization: tenant and stream isolation;
- Storage: optional large submitted artifacts;
- Vault/Function Secrets: signing keys and external credentials;
- Cron: optional retention cleanup, retry sweeps, and monitors hosted by Agent Feed;
- Realtime: optional admin dashboard only.

## Separate deployment

The production default is a separate Supabase project from each consumer. Cross-project delivery uses signed HTTPS events. A same-project prototype is allowed only if the public protocol remains the only integration boundary.

## No pgvector requirement

Vector search is not needed for protocol correctness. It may later assist operator search or duplicate suggestions but cannot replace consumer semantic dedupe or evidence policy.
