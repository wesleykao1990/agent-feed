# ADR-0005: Signature, trace, and pull-cursor contract

- Status: Accepted for implementation; code not yet complete
- Date: 2026-08-18
- Scope: Wire compatibility, signatures, trace lineage, and pull delivery

## Context

Protocol `0.1` delivery events are strict snake_case JSON contracts with a
compatibility baseline. The prototype currently has camelCase event objects and
several canonical-JSON helpers. M2 needs signed webhook delivery, end-to-end
traceability, and a pull cursor without silently changing the protocol body.

## Decision

- Keep the signed body as the existing protocol `0.1` `DeliveryEvent`.
- Convert to the exact snake_case wire representation before canonicalization
  and signing.
- Keep the existing HMAC input contract, `timestamp.raw_body`, and replay
  window unless a separate security ADR approves a change.
- Use one shared canonical JSON and HMAC implementation in
  `packages/protocol-runtime/`.
- Keep delivery attempt, key ID, and internal trace metadata in delivery state
  and transport headers; do not add body fields to protocol `0.1` implicitly.
- Use an opaque cursor representing a stable `(created_at,event_id)` ordering;
  the unique event ID is the tie-breaker for equal timestamps.
- A cursor is scoped to one authenticated consumer/subscription and cannot be
  reused across consumers.

## Rejected alternatives

- Sign the in-memory camelCase object: it is not the schema-defined wire body.
- Add `trace_id` as an undocumented event property: strict schema validation
  and generated types would drift.
- Use offset pagination: inserts/deletes between requests can skip or repeat
  events.
- Include raw source content in trace or metric labels: violates data
  minimization and can expose secrets or personal data.

## Consequences

Transport adapters need a wire conversion step and shared runtime dependency.
Trace metrics can correlate the signed event ID immediately; a future protocol
version can add a first-class trace field if required. Pull APIs must persist
or validate cursor scope and ordering.

## Validation

- schema validation of the exact signed wire body;
- altered-body, wrong-key, and stale-timestamp rejection;
- cross-package canonical JSON/signature parity test;
- same-timestamp cursor pagination test;
- wrong-consumer cursor rejection;
- trace lineage assertion from ingress through replay.
