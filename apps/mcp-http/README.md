# Agent Feed remote MCP gateway

This app exposes the same three lifecycle tools as `@agent-feed/mcp-server`
over public Streamable HTTP:

- `begin_run`
- `submit_batch`
- `complete_run`

It is a transport/authentication composition only. Lifecycle validation,
tenant and stream scope, rate limiting, idempotency, quarantine, and durable
PostgreSQL writes remain owned by `ProducerService` and its persistence port.

## Authentication modes

Long-lived producer secrets can be supplied as a Bearer token by clients that
support static MCP headers. The gateway maps the validated credential to a
request-scoped principal; credentials are never accepted in tool arguments.

For a Claude Pro/Max acceptance test, set
`AGENT_FEED_MCP_OAUTH_OPERATOR_SECRET` to enable the embedded authorization
code + PKCE provider. It uses dynamic client registration and short-lived,
opaque tokens. The operator approves a connector by entering the passphrase
on the Agent Feed consent screen.

The embedded provider is deliberately a single-process pilot: registrations,
grants, and tokens are memory-only and disappear on restart. A production
multi-instance deployment must replace it with a durable OAuth 2.1/OIDC
provider while retaining the `AccessTokenVerifier` boundary.

## Required environment

```text
AGENT_FEED_DATABASE_URL=postgresql://...
AGENT_FEED_TENANT_ID=tenant-id
AGENT_FEED_PRODUCER_ID=claude-producer
AGENT_FEED_PRODUCER_SECRET=<random producer secret>
AGENT_FEED_ALLOWED_STREAMS=rewards-watch
AGENT_FEED_MCP_PUBLIC_URL=https://public.example/mcp
AGENT_FEED_MCP_OAUTH_OPERATOR_SECRET=<24+ character operator passphrase>
```

Optional hardening:

```text
HOST=127.0.0.1
PORT=7080
AGENT_FEED_MCP_ALLOWED_HOSTS=additional.example
AGENT_FEED_MCP_ALLOWED_ORIGINS=https://claude.ai
AGENT_FEED_MCP_MAX_BODY_BYTES=1048576
```

Start with `npm start`. The public URL must terminate TLS before forwarding to
the loopback listener. `/health` contains no database or credential details.
