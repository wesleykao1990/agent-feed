# Durable producer REST API

Status: **executable PostgreSQL-backed producer ingress.** The API composes
`PostgresAgentFeedPersistence` through the `@agent-feed/producer-service`
application boundary and delegates HTTP routing/framing to the reusable
`@agent-feed/rest-adapter` package. It does not import the prototype store and
does not contain SQL.

Run it after configuring `AGENT_FEED_DATABASE_URL` and either a JSON
`AGENT_FEED_PRODUCER_CREDENTIALS` array or the individual credential
environment variables described in `src/main.ts`:

```sh
npm install
npm start
```

`/health` is process health. `/ready` and `/readiness` check the injected
PostgreSQL pool. Every producer route requires a scoped Bearer credential.

M1 producer reference endpoints:

```text
POST /v1/runs:begin
POST /v1/runs/{run_id}/batches
POST /v1/runs/{run_id}:complete
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/findings
```

Write and read endpoints require scoped producer credentials. Authentication
binds a tenant, producer, and allowed stream IDs; a run outside that scope is
reported as `run_not_found` rather than revealing whether it exists. M2
consumer operations are specified in
`docs/operations/delivery-api.md` and are not implemented here yet:

- subscription creation/update/listing;
- pull pages and scoped cursors;
- acknowledgement;
- dead-letter inspection and replay.

The API requires `Content-Type: application/json` and accepts only canonical
snake_case protocol `0.1` JSON. Body size,
batch cardinality, excerpt/metadata sizes, secret/PII policy, rate limits,
schema shape, and semantic checks run before persistence. Repeating an
idempotency key is handled by PostgreSQL and returns the original durable
result. The prototype remains available separately for local demonstrations;
it is not the production ingress path.

The built-in limiter is process-local. A multi-replica deployment must inject
or place in front of the service a shared tenant/producer limiter while
retaining the same fail-closed policy and `Retry-After` behavior.
