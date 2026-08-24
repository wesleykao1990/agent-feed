# Agent Feed remote MCP gateway

This app exposes Agent Feed producer lifecycle tools over public Streamable HTTP:

- `begin_run`
- `submit_batch`
- `complete_run`
- `submit_bounded_run` on the hosted/remote surface

`submit_bounded_run` executes begin -> zero-or-more batch submissions -> complete inside one MCP invocation and reuses the existing idempotency contract. It is the preferred ChatGPT production path because a conversation interruption cannot strand the client between separate lifecycle tool calls.

The gateway is a transport/authentication composition only. Lifecycle validation, tenant and stream scope, rate limiting, idempotency, quarantine, and durable PostgreSQL writes remain owned by `ProducerService` and its persistence port.

## Authentication modes

Existing producer secrets can still be supplied as Bearer tokens by non-ChatGPT clients that support static MCP headers.

For interactive OAuth clients, the repository retains `PilotOAuthProvider` for local/single-process acceptance tests. Its state is memory-only by design.

Hosted deployments use `PersistentOAuthProvider` with `PostgresOAuthStateStore`. Dynamic client registrations, authorization codes, access tokens, and refresh tokens are stored as hashes/payloads in the Agent Feed PostgreSQL database so authorization survives cold starts and deployments. The hosted flow remains OAuth 2.1 authorization-code + PKCE with the `agent-feed:write` scope and explicit operator approval.

## Required hosted environment

```text
AGENT_FEED_DATABASE_URL=postgresql://...
AGENT_FEED_PRODUCER_CREDENTIALS=[...]
AGENT_FEED_MCP_PUBLIC_URL=https://your-stable-host.example/mcp
AGENT_FEED_MCP_OAUTH_OPERATOR_SECRET=<24+ character operator passphrase>
```

The usual individual producer credential environment variables may be used instead of `AGENT_FEED_PRODUCER_CREDENTIALS` when only one principal is configured.

Optional hardening:

```text
AGENT_FEED_MCP_ALLOWED_HOSTS=preview-or-additional-host.example
AGENT_FEED_MCP_ALLOWED_ORIGINS=https://chatgpt.com
AGENT_FEED_MCP_MAX_BODY_BYTES=1048576
```

Do not place database URLs, producer credentials, OAuth operator secrets, access tokens, or refresh tokens in prompts or checked-in deployment configuration.

## Vercel deployment

The Vercel project root is this directory (`apps/mcp-http`). `vercel.json` rewrites the public MCP, health, OAuth and well-known discovery routes to `api/gateway.ts`, which uses the Web-standard Request/Response handler.

The hosted runtime is serverless-safe:

- it does not open a long-lived TCP listener;
- it reuses a module-scoped pool/service/gateway while an instance is warm;
- it initializes only the small idempotent OAuth sidecar on cold start;
- it assumes the primary Agent Feed schema has already been migrated through the normal Agent Feed deployment process;
- it returns a bounded 503 response instead of logging raw configuration or request failures.

The stable production URL in `AGENT_FEED_MCP_PUBLIC_URL` must end in `/mcp` and must match the hostname ChatGPT connects to. Preview hosts can be added explicitly through `AGENT_FEED_MCP_ALLOWED_HOSTS` for testing.

## Standalone Node deployment

`src/main.ts` remains available for a VM/container deployment. It listens on `HOST`/`PORT`, applies the normal Agent Feed migrations, and can use the single-process pilot OAuth provider for acceptance testing. The Vercel deployment does not use this listener entrypoint.

## Health and acceptance

`GET /health` returns only `{ "status": "ok" }` when the gateway is initialized. A production ChatGPT acceptance test should additionally verify OAuth discovery/registration and confirm that tool discovery returns all four tools.

After changing tool metadata or the hosted endpoint, refresh the developer plugin connection in ChatGPT and start a new conversation so ChatGPT performs fresh tool discovery.

```sh
npm run build
npm test
```
