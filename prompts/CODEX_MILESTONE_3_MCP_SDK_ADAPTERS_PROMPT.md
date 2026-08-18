# Codex prompt — Agent Feed Milestone 3 MCP, SDKs, and adapters

Begin from the merged Agent Feed Milestone 2 and Milestone 1 corrective release
baseline. Work only in the Agent Feed repository; the Rewards Optimizer is a
separate project and is outside this milestone.

Implement:

- MCP tools `begin_run`, `submit_batch`, and `complete_run`;
- TypeScript and Python producer/consumer SDKs;
- REST, local-file, generic-webhook, Claude-hook, and ChatGPT manual-export
  adapters;
- ChatGPT and Claude operating skills; and
- a capability-gated Scheduled Task export path whose safe fallback is a
  protocol-valid run bundle.

All producer transports must delegate validation, authorization, security,
idempotency, and terminal-state policy to `@agent-feed/producer-service`.
SDKs and adapters must not import database implementation. Consumer SDKs may
target an injected transport without claiming the accepted transport-neutral
delivery API has a deployed HTTP server.

On failure before begin, return a stable redacted error with no lifecycle side
effects. On failure after begin, attempt an idempotent `partial` or `failed`
completion; if Agent Feed remains unreachable, return or persist deterministic
recovery material. Never silently discard a partial run.

Gate the milestone only after clean package installs/builds/tests, behavioral
REST/MCP service-boundary proof, tool-less bundle import, capability-present
and capability-absent export cases, failure/recovery injection, secret
redaction, architecture checks, and the full existing live PostgreSQL M0-M2
regression suite. Record every decision, bug, learning, and remaining
refactor/operational debt in the Milestone 3 documentation.
