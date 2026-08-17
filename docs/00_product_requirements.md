# Product requirements — Agent Feed v0.1.1

## Product promise

Provide a small, generic, trustworthy ingestion protocol through which agents and automations can report runs, findings, and submitted evidence to consumer applications without pretending that agent output is verified truth.

## Core problem

A monitoring application must distinguish:

```text
completed run with zero findings
partial or failed run
run that should have happened but never arrived
message that was produced but temporarily failed delivery
```

Most generic webhook designs capture only messages that happened. Agent Feed also models expected-run liveness so silence cannot masquerade as health.

## Initial users

- an API-based semantic monitoring worker;
- a manually exported ChatGPT run bundle;
- the Japan Rewards Optimizer as the first consumer;
- later consumers such as Signal Ledger, event intelligence, job monitoring, and research systems.

## Required producer flow

```text
begin_run
  → zero or more submit_batch calls
  → complete_run
```

A terminal run records actual scope, source success counts, errors, and terminal status. Idempotency retries return the original result; payload drift under one idempotency key is rejected.

## Required consumer guarantees

- findings are immutable untrusted claims;
- submitted evidence is immutable producer material;
- terminal runs cannot be rewritten;
- expected cadence is registered independently of the producer;
- overdue streams raise incidents;
- delivery is at-least-once and consumers are idempotent;
- Realtime is never the durable queue;
- hostile-source flags survive transport;
- no reward-specific concepts enter Agent Feed contracts.

## Thin v0.1.1 implementation scope

Build now:

- nine JSON Schemas;
- begin/submit/complete application service;
- local-file importer and one REST path;
- PostgreSQL persistence and immutability;
- stream expectations and liveness sweep;
- HMAC-signed event contract;
- hostile run-bundle fixture;
- one Rewards reference consumer example.

Defer until measured demand or a second consumer:

- complete Python SDK;
- broad adapter catalogue;
- polished MCP deployment;
- multi-tenant admin dashboard;
- separate production Supabase project;
- Realtime dashboard;
- generic workflow orchestration.

## Non-functional requirements

- protocol version pinned to `0.1`;
- HMAC-SHA256 signatures;
- five-minute replay window;
- one-MiB request body limit;
- at most 100 findings and 100 evidence items per batch;
- stream-scoped authorization;
- terminal processing cannot retain pending redaction;
- purge deadlines must be executed by a scheduled job, not merely stored.

## Prototype acceptance

The bundled prototype proves:

- idempotent begin/batch/complete;
- terminal immutability;
- zero-finding completion;
- evidence-reference validation;
- overdue missing-run detection;
- degraded partial-run health;
- hostile security-flag preservation;
- HMAC stale-request rejection.
