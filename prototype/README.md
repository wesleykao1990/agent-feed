# Agent Feed runnable prototype v0.1.1

A zero-dependency TypeScript prototype of the generic protocol. It implements:

- `beginRun`, `submitBatch`, and `completeRun`;
- idempotency-key payload consistency;
- immutable terminal runs with idempotent completion retry;
- completed zero-finding semantics;
- consumer-owned expected cadence and overdue-run detection;
- finding/evidence delivery events;
- HMAC-SHA256 signing with a five-minute replay window;
- fixed batch/body limits and key-rotation overlap constants;
- preservation of hostile-source security flags.

It contains no reward-specific concepts.

```bash
npm run build
npm test
npm run demo
npm run dev
```

Node 22 runs the TypeScript using its built-in type-stripping flag, so no package installation is required. This prototype is a starting implementation, not production persistence, delivery, or authentication.
