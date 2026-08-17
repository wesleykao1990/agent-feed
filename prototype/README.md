# Agent Feed runnable prototype v0.1.1

A TypeScript prototype of the generic protocol. It implements:

- `beginRun`, `submitBatch`, and `completeRun`;
- idempotency-key payload consistency;
- immutable terminal runs with idempotent completion retry;
- completed zero-finding semantics;
- consumer-owned expected cadence and overdue-run detection;
- finding/evidence delivery events;
- HMAC-SHA256 signing with a five-minute replay window;
- fixed batch/body limits and key-rotation overlap constants;
- preservation of hostile-source security flags.
- Draft 2020-12 validation for portable run bundles;
- authenticated REST and local-file bundle intake;
- completion-count reconciliation before state mutation;
- rejection of secret-bearing submitted evidence;
- scoped per-producer credentials with constant-time bearer verification;
- per-producer sliding-window request limits and stable HTTP error mapping;
- PII, secret-field, and hostile-finding quarantine hooks.

It contains no reward-specific concepts.

```bash
npm ci
npm run build
npm test
npm run demo
npm run dev
npm run import:file -- ../examples/run-bundle.zero-findings.example.json
```

Node 22 runs the TypeScript using its built-in type-stripping flag. Ajv validates
wire input against the canonical protocol schemas. This prototype is a starting
implementation, not production persistence or durable delivery.

The REST server keeps the original `token` option for local compatibility. New
deployments can pass `credentials` instead:

```ts
createAgentFeedServer({
  credentials: [{
    producerId: "monitor-jp",
    secret: process.env.MONITOR_JP_TOKEN!,
    allowedStreamIds: ["rewards.daily"],
  }],
  rateLimit: { maxRequestsPerMinute: 60 },
  security: {
    onQuarantine: (event) => console.warn("quarantine", event),
  },
});
```

Legacy token mode is intentionally wildcard-scoped for the prototype’s existing
local REST/run-bundle examples; production credentials should always name their
producer and allowed streams. Quarantine callbacks receive IDs, flags, and
field paths, never secret values or evidence excerpts.
