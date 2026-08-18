# Changelog

## Unreleased — Milestone 5A

- Added a GitHub-oriented operator CLI for private setup, diagnostics,
  non-destructive PostgreSQL lifecycle, and protocol-clean MCP launch.
- Added a localhost-only PostgreSQL 16 Compose profile with a persistent named
  volume and an owner-only existing-database credential-file option.
- Added path containment, symlink refusal, ambient credential scrubbing, safe
  forced-upgrade credential preservation, and secret-free output/wrappers.
- Added a clean-checkout M5A CI gate, adversarial tests, installation and
  upgrade runbooks, ADR, and append-only decisions/bugs/learnings/debt records.
- Kept OpenAI tunnel/plugin/task mutations and the remainder of the broader
  Milestone 5 roadmap explicitly out of scope.

## Milestone 4

- Fixed durable full-bundle replay after completion: exact accepted batch
  retries return the original receipt, while payload drift and new terminal
  batches remain rejected.
- Added a PostgreSQL-backed ChatGPT Scheduled Task adapter regression with an
  evidence-bearing bundle, closing the zero-batch retry coverage gap.
- Added a buildable, packed TypeScript reference consumer at the historical
  `examples/rewards-optimizer/` path without implementing the external app.
- Added authenticated tenant/consumer/stream scope, explicitly untrusted
  observation mapping, separate transport/semantic dedupe, and fail-closed
  reused-event payload conflict handling.
- Added hostile/evidence/unknown-attribute preservation with no promotion,
  database, Agent Feed server, private-source, or Realtime dependency.
- Added a zero-skip M4 architecture/behavior/package gate and a separate
  Node-only GitHub Actions job.

## Milestone 3

- Added a production MCP stdio server exposing exactly `begin_run`,
  `submit_batch`, and `complete_run` through the shared producer service.
- Added transport-injected TypeScript and Python producer/consumer SDKs with
  bounded idempotency-aware retries and redacted errors.
- Added reusable REST, local-file, signed generic-webhook, Claude-hook, and
  ChatGPT manual-export adapters with explicit failure recovery.
- Added capability-gated ChatGPT/Claude skills, runnable M3 examples, ADRs, and
  a no-skip combined M3 architecture/conformance gate.
- Merged PR #4 after hosted CI run `32089258429` passed.

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
