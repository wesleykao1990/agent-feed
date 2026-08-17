# Supabase example

Use a dedicated Supabase project in production.

- private schemas for core tables;
- Edge Functions for REST/MCP ingress and signed webhook delivery;
- Queues/PGMQ for outbox processing, retry, and dead-letter work;
- Storage only for large submitted artifacts;
- Vault/Function Secrets for producer credentials and signing keys;
- Cron only for retention/retry sweeps or monitors explicitly hosted here;
- Realtime only for an optional admin dashboard.

Do not expose queue schemas or core Agent Feed tables to browser clients.
