# Claude hook adapter

`@agent-feed/claude-hook-adapter` maps Claude hook or scheduled-agent events
to `beginRunWithWireId`, `submitBatch`, and `completeRun` on the injected
producer service. It supports equivalent `run.started`/`batch.submitted` /
`run.completed` names and compact `start`/`batch`/`complete` aliases for hook
runtimes. The adapter owns no SQL and does not duplicate producer validation,
authorization, security, or idempotency policy.

```ts
const hook = new ClaudeHookAdapter({ service, principal });
await hook.handle({ type: "run.started", run_id, begin });
await hook.handle({ type: "batch.submitted", run_id, batch });
await hook.handle({ type: "run.completed", run_id, complete });
```

Events are bounded before processing and hook exception text is never returned.
If a batch or completion fails after begin, the adapter attempts an idempotent
terminal `partial`/`failed` completion using the accepted prefix and returns
`run.partial` for a partial closure. If Agent Feed is unreachable (including an
uncertain begin), `ClaudeHookImportFailure.recovery` (and the optional recovery
store) contains an exact protocol-valid run bundle with stable keys for later
local-file replay. The active map is only a short-lived event correlation aid;
durability remains in the producer service or explicit recovery store.
