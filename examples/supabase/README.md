# Supabase deployment reference

This directory is a deployable Supabase reference for Agent Feed protocol
`0.1`. It is intentionally separate from the application packages: the
canonical producer service and delivery worker remain the policy boundaries,
while Supabase supplies managed PostgreSQL, optional Edge Functions, and
operator scheduling.

This is a reproducible deployment example, not proof that a hosted project has
already been created. The local/static gate is:

```sh
node examples/supabase/tests/verify.mjs
```

The hosted proof requires a user-owned Supabase project and credentials. No
credentials are checked in, and no hosted project is mutated by this example.

## Layout

```text
examples/supabase/
├── config.toml
├── migrations/
│   ├── 0001_agent_feed.sql
│   ├── 0002_durable_delivery.sql
│   ├── 0003_wire_run_id.sql
│   └── 0004_supabase_security.sql
├── functions/
│   └── producer-ingress/index.ts
└── tests/
    ├── 001_liveness_and_immutability.sql
    └── verify.mjs
```

The first three migrations are byte-for-byte copies of the canonical
PostgreSQL history. The static gate detects drift, so a Supabase deployment
cannot silently use a different protocol schema. Migration `0004` revokes
browser-role access to the private schema, enables RLS as defense in depth,
and grants only a non-sensitive health RPC to `service_role`.

## Deployment sequence

1. Create a separate Supabase project for Agent Feed. Keep it separate from
   every consumer project; cross-project delivery remains signed HTTPS.
2. Install the Supabase CLI, copy this directory as the project configuration
   (or link the project from this directory), and replace `project_id` in
   `config.toml` with the target project ref.
3. Review the migration files and apply them with the Supabase migration
   workflow (`supabase db push`). Review the generated plan before approval.
4. Configure the canonical Agent Feed API with the Supabase **server-side**
   connection string as `AGENT_FEED_DATABASE_URL`. Use a pooled connection for
   the API and a direct connection for migrations when the project supplies
   both. Do not put either connection string in browser code.
5. Configure producer credentials in the canonical API. Credentials remain
   tenant/producer/stream scoped and are never stored in the Edge Function.
6. Optionally deploy `functions/producer-ingress`. Set the Edge Function
   secret `AGENT_FEED_INGRESS_URL` to an HTTPS canonical API URL, then publish
   the function. The function is a narrow route/header allowlisted relay; it
   does not implement a second persistence or validation path.
7. Run the operational proof against the project database using the SQL
   fixture in `tests/001_liveness_and_immutability.sql`, then record the
   migration receipt, health response, liveness result, and rollback decision
   in the deployment record.

The canonical API must complete its normal migration/startup check before
accepting producer traffic. A Supabase database alone is not a producer REST
implementation; bypassing the API and inserting protocol rows directly is not
an accepted ingress path.

## Optional Edge Function ingress

The function is configured with `verify_jwt = false` because Supabase's generic
JWT verifier cannot replace Agent Feed's producer credential semantics. Every
request still requires an Agent Feed `Authorization: Bearer ...` credential,
and the canonical upstream service performs authentication, stream scope,
protocol schema validation, limits/quarantine, idempotency, and durable
transactions.

Allowed routes are:

```text
POST /v1/runs:begin
POST /v1/runs/{run_id}/batches
POST /v1/runs/{run_id}:complete
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/findings
```

Only `authorization`, JSON `content-type`, and a bounded `x-request-id` are
forwarded. Cookies, arbitrary headers, query strings, redirects, non-HTTPS
upstreams, and request bodies over 1 MiB are rejected. Outbound signed webhook
delivery remains the delivery worker's HMAC boundary; Realtime is not needed
for protocol correctness or delivery.

## Security and rollback

- Keep `service_role`, database URLs, producer secrets, signing keys, and
  storage credentials in Supabase secrets or an external secret manager.
- Never grant `anon` or `authenticated` access to `agent_feed`, queue tables,
  outbox rows, or signing metadata. The migration makes this restriction
  explicit and keeps future objects private by default.
- Do not expose Realtime subscriptions for core Agent Feed tables. An admin
  dashboard may consume a separately authorized summary endpoint later.
- Treat submitted evidence, URLs, and model output as untrusted. The canonical
  producer service remains responsible for secret/hostile-content checks.
- A failed migration must be stopped before traffic is enabled. Rollback is a
  reviewed Supabase migration operation; do not drop the schema or volume as a
  convenience. If a forward migration has accepted rows, write a compensating
  migration and preserve the append-only audit history.

The liveness SQL test runs in a transaction and rolls back its fixture rows. It
proves terminal-run immutability and overdue-stream incident creation on a
database that has the migrations applied; it does not claim a hosted Supabase
run until an operator records that receipt.
