# Codex initiating prompt — Agent Feed v0.1.1

Implement Agent Feed Milestones 0 and the deliberately thin Milestone 1 only. Agent Feed remains a separate generic project, but the package already includes a runnable zero-dependency prototype. Extend it; do not delete it and start from scratch.

Read `README.md`, `PRD.md`, `docs/00_product_requirements.md`, `docs/01_protocol.md`, `docs/02_trust_model.md`, `docs/03_implementation_plan.md`, `docs/05_security_privacy.md`, `docs/07_chatgpt_monitoring.md`, `docs/10_semantic_invariants.md`, all nine schemas, examples, reference SQL, and every file under `prototype/`.

Before refactoring, run:

```bash
cd prototype
npm test
npm run demo
```

## Required result

Create a strict TypeScript implementation of:

```text
begin_run
  → idempotent running envelope
submit_batch
  → atomic immutable findings/evidence
complete_run
  → immutable terminal envelope and event
expected cadence
  → overdue-run incident when a run never arrives
```

Use JSON Schema Draft 2020-12 as the cross-language wire contract, generated/inferred types, semantic validation, PostgreSQL, and a minimal REST API plus local-file importer. Implement the pinned HMAC/replay/body/batch limits. Preserve zero-finding versus absent-run semantics. Preserve hostile-source flags and quarantine hooks.

Do not implement the Rewards domain, canonical evidence, full durable multi-consumer delivery, Python SDK, generic webhook, Claude hook, polished MCP deployment, Realtime dashboard, or a separate production Supabase deployment in this run.

Mandatory tests:

- duplicate idempotency returns the original result;
- duplicate key with different payload conflicts;
- completed zero-finding run is queryable;
- expected stream with no terminal run becomes overdue;
- partial and failed runs preserve actual scope/errors;
- terminal run and accepted batches/findings/evidence are immutable;
- evidence references resolve;
- HMAC timestamp outside 300 seconds is rejected;
- hostile run bundle retains security flags;
- terminal processing cannot remain redaction-pending.

Stop after the minimal Milestone 1 gate and report whether the two-lane rehearsal can begin.
