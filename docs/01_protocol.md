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

Ingress operations are idempotent. External delivery is at-least-once: consumers must deduplicate by `event_id` and by their own semantic fingerprint. The service never claims end-to-end exactly-once delivery across HTTP boundaries.

## Namespacing

`stream_id`, `finding_type`, routing tags, and producer IDs are namespaced strings. Domain-specific content belongs in `attributes`; consumers validate and map it into their own contracts.
