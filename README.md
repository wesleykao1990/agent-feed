# Agent Feed Foundation v0.1.1

Agent Feed is a standalone, reusable project for transmitting structured agent runs, findings, and submitted evidence to multiple consumer applications.

It is intentionally separate from the Japan Rewards Optimizer. The two projects communicate through Agent Feed protocol `0.1`; neither project reads the other's database.

## Project layout

```text
packages/schema
packages/sdk/typescript
packages/sdk/python
packages/adapters
apps/mcp-server
apps/api
skills/chatgpt
skills/claude
examples/postgres
examples/supabase
examples/sqlite
examples/rewards-optimizer
```

## Trust boundary

A `Finding` means “a producer submitted this claim,” not “this is true.” Submitted evidence is not automatically canonical evidence. Consumer applications apply their own source authority, verification, retention, and domain rules.

## Runnable prototype

`prototype/` implements the thin run lifecycle, idempotency, terminal immutability, signed events, expected-cadence liveness, and hostile-finding preservation without external dependencies. Run `cd prototype && npm test`.

## Start implementation

Use `prompts/CODEX_INITIATING_PROMPT.md`, then `prompts/CODEX_MILESTONE_2_DELIVERY_PROMPT.md`.

## ChatGPT monitoring

ChatGPT monitoring tasks can serve as independent sentinels. Current Scheduled Tasks do not provide webhooks, so automatic production ingestion must use a tool-capable runtime or a separate API worker. The fallback is a validated run-bundle imported through `local-file`.

## Supabase

Recommended production deployment uses a separate Supabase project with Postgres, Edge Functions, Queues, scoped auth/RLS, optional Storage, and secrets. Realtime is optional for live dashboards and is never the delivery queue.
