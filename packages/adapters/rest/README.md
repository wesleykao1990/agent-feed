# REST producer adapter

`@agent-feed/rest-adapter` is the transport boundary for the producer
application service. It exposes the protocol `0.1` lifecycle routes and
delegates authentication, stream scope, schema/security checks, idempotency,
and terminal-state policy to an injected `@agent-feed/producer-service`
`ProducerService`. It has no PostgreSQL dependency.

```ts
import { createRestServer } from "@agent-feed/rest-adapter";

const server = createRestServer({ service });
server.listen(7071, "127.0.0.1");
```

The same boundary is available without a Node HTTP server through
`handleRestRequest` or `RestProducerAdapter.handle`. Routes are:

```text
POST /v1/runs:begin
POST /v1/runs/{run_id}/batches
POST /v1/runs/{run_id}:complete
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/findings
GET  /health
GET  /ready
```

Every lifecycle request requires a scoped Bearer credential and
`Content-Type: application/json`. Request bytes are bounded before parsing;
invalid JSON, unsupported media, rate limits, and producer-service errors map
to stable `{ "error": "..." }` responses. Authorization values, persistence
messages, payloads, and evidence excerpts are never returned in diagnostics.
The adapter does not retry writes itself: callers repeat the same idempotency
key and let the durable service return its original receipt.

`apps/api` is the PostgreSQL composition/compatibility wrapper around this
package. It keeps the historical `createAgentFeedApiServer` options and API
health label while sharing this exact request handler.
