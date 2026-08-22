# Agent Feed protocol v0.1

## Purpose

Agent Feed is a generic, domain-neutral transport for agent runs, findings, and submitted evidence. It lets ChatGPT, Claude, custom API workers, humans, and automation deliver structured research outputs to multiple applications without teaching each producer every consumer's internal schema.

## Core lifecycle

```text
begin_run
  → zero or more submit_batch calls
  → complete_run
```

A completed zero-finding run is materially different from a run that failed before checking its expected scope.

## Core objects

- `RunEnvelope`: producer, task, expected/actual scope, lifecycle, and statistics.
- `Finding`: an agent-supplied claim or lead with generic assessments and evidence references.
- `SubmittedEvidence`: material supplied by the producer; not automatically canonical evidence.
- `DeliveryEvent`: versioned event sent to a subscribed consumer.

## Delivery semantics

Ingress operations are idempotent. External delivery is at-least-once:
consumers must durably deduplicate by `event_id` and by their own semantic
fingerprint. The service never claims end-to-end exactly-once delivery across
HTTP boundaries.

The `DeliveryEvent` `attempt` field is required in the signed protocol `0.1`
body. Retries and replays re-encode and re-sign the body with a new attempt;
`event_id`, payload, `occurred_at`, and payload hash remain the immutable source
identity. Signature metadata and trace headers remain outside the strict event
body.

Milestone 2 implementation acceptance is complete for the accepted repository
surface. The latest local evidence is protocol 5, pure conformance 6,
architecture 4, live PostgreSQL 3, delivery-core 18, delivery-consumer 10,
persistence 11, webhook 8, worker 6, and API 5. The corrected serialized live
PostgreSQL gate and all seven clean package installs/builds/tests pass. Hosted
GitHub Actions CI run #5 also passed on draft PR #2 for commit `ad4ea3a`. The
API remains transport-neutral with no deployable HTTP server; the worker now
has a bounded process/CLI entrypoint with owner-only signing-key reference
resolution, and observability exporter/deployment work remains future
operational scope.

## Namespacing

`stream_id`, `finding_type`, routing tags, and producer IDs are namespaced strings. Domain-specific content belongs in `attributes`; consumers validate and map it into their own contracts.
