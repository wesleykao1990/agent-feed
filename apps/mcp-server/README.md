# Agent Feed MCP server

This directory contains the executable, stdio MCP adapter for the Agent Feed
producer lifecycle. It exposes exactly three write tools:

- `begin_run`
- `submit_batch`
- `complete_run`

The adapter is deliberately thin. `@agent-feed/producer-service` remains the
single policy boundary for published schema validation, producer
authentication, stream scope, request limits, security/quarantine checks,
idempotency, terminal immutability, and persistence error mapping. MCP does
not import SQL or query the database. The production composition root injects
the same `PostgresAgentFeedPersistence` and `ProducerService` used by the REST
application.

## Run the server

Configure `AGENT_FEED_DATABASE_URL` (or `DATABASE_URL`) and either one JSON
credential array or the individual credential variables:

```sh
export AGENT_FEED_DATABASE_URL='postgres://...'
export AGENT_FEED_PRODUCER_CREDENTIALS='[{"tenant_id":"tenant_a","producer_id":"producer_a","secret":"...","allowed_stream_ids":["stream.a"]}]'
npm install
npm start
```

The stdio process reads JSON-RPC messages from stdin and writes responses to
stdout. Configuration and credentials are never printed. The executable
composition uses the official `@modelcontextprotocol/server@2.0.0` SDK and
`serveStdio(factory)`, which pins one protocol era per connection:

- Modern MCP `2026-07-28` starts with `server/discover`. Every request carries
  `params._meta` with
  `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities` (plus optional client info).
  Modern results include `resultType: "complete"` and identify this server in
  `_meta["io.modelcontextprotocol/serverInfo"]`.
- Legacy MCP through `2025-11-25` uses `initialize` followed by
  `notifications/initialized`, then `tools/list` and `tools/call`. The same
  factory serves both eras; modern revisions are never counter-offered from a
  legacy `initialize` response.

The package-root API leads with the official SDK server and stdio functions.
`src/server.ts` retains a small deterministic JSON-RPC facade only for the
repository's conformance/legacy tests; it is not used by the executable and is
not re-exported from the package root. Tool input schemas are the published
Agent Feed `0.1` schemas and are strictly snake_case.

`AGENT_FEED_MCP_AUTHORIZATION` may select the bearer value when multiple
credentials are configured; otherwise `AGENT_FEED_MCP_PRODUCER_SECRET`,
`AGENT_FEED_PRODUCER_SECRET`, or the sole configured credential is used.

## Composition and tests

Production code can use `createOfficialMcpServerFromEnvironment` or inject an
already composed service into `createOfficialMcpServer`; use
`serveAgentFeedMcpStdio` when the host owns the transport. Tests can inject a
`ProducerPrincipal` to avoid credentials entirely, or inject an authorization
string and exercise the service authenticator. `LifecycleToolRouter` is
transport-independent and is useful for focused tool tests.

```sh
npm run build
npm test
```

Tool failures return MCP `isError: true` results containing only a stable
error code. JSON-RPC protocol failures use deterministic standard error codes;
unknown service/adapter failures become `internal_error`. Raw exception
messages, SQL, credentials, payload details, and persistence identifiers are
never included in errors.
