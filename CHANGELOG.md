# Changelog

## Unreleased — Milestone 3

- Added a production MCP stdio server exposing exactly `begin_run`,
  `submit_batch`, and `complete_run` through the shared producer service.
- Added transport-injected TypeScript and Python producer/consumer SDKs with
  bounded idempotency-aware retries and redacted errors.
- Added reusable REST, local-file, signed generic-webhook, Claude-hook, and
  ChatGPT manual-export adapters with explicit failure recovery.
- Added capability-gated ChatGPT/Claude skills, runnable M3 examples, ADRs, and
  a no-skip combined M3 architecture/conformance gate.

## 0.1.1 — 2026-08-17

- Added consumer-owned stream cadence and missed-run liveness.
- Pinned transport security defaults and ChatGPT sentinel capacity boundaries.
- Added immutable terminal/accepted records and hostile run-bundle fixture.
- Added a runnable zero-dependency protocol prototype.


## 0.1.0 — 2026-08-17

- Added generic run, finding, evidence, batch, completion, delivery-event, and run-bundle contracts.
- Defined producer and consumer SDK boundaries.
- Added REST, MCP, webhook, Claude, ChatGPT/manual-export, and local-file adapter plans.
- Defined outbox/queue delivery, idempotency, signed webhooks, and at-least-once consumer semantics.
- Added a separate Rewards Optimizer reference integration without domain coupling.
- Made Realtime optional and documented current ChatGPT Scheduled Task webhook limitations.
