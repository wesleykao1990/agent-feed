# ADR-0005: Signature, trace, and pull-cursor contract

- Status: Accepted and implemented in the M2 repository
- Date: 2026-08-18
- Scope: Wire compatibility, signatures, trace lineage, and pull delivery

## Context

Protocol `0.1` delivery events are strict snake_case JSON contracts with a
compatibility baseline. The prototype currently has camelCase event objects and
several canonical-JSON helpers. M2 needs signed webhook delivery, end-to-end
traceability, and a pull cursor without silently changing the protocol body.

## Decision

- Keep the signed body as the existing protocol `0.1` `DeliveryEvent`, including
  its required `attempt` field.
- Convert to the exact snake_case wire representation before canonicalization
  and signing.
- Re-encode and re-sign the body for every retry/replay attempt. `event_id`,
  payload, `occurred_at`, and payload hash are the immutable source identity;
  the body-level attempt is delivery metadata required by protocol `0.1`.
- Keep the existing HMAC input contract, `timestamp.raw_body`, and replay
  window unless a separate security ADR approves a change.
- Use one shared canonical JSON and HMAC implementation in
  `packages/protocol-runtime/`.
- Keep key ID, delivery ID, and internal trace metadata in delivery state and
  transport headers; do not add new body fields to protocol `0.1` implicitly.
  The existing body-level attempt is not moved out of the body.
- Use an opaque cursor representing a tenant-global monotonic delivery
  position; the unique event ID remains a deterministic tie-breaker where
  timestamps or compatibility views require one.
- A cursor is scoped to one authenticated consumer/subscription and cannot be
  reused across consumers.

## Rejected alternatives

- Sign the in-memory camelCase object: it is not the schema-defined wire body.
- Freeze one raw body across retries while changing `attempt`: protocol `0.1`
  requires the attempt in the signed body, so the raw bytes and signature must
  change while source identity remains stable.
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

## Implementation review — 2026-08-18

Protocol-runtime has 5/5 tests covering canonical snake_case encoding,
body-level attempt, exact raw-body HMAC, key rotation, and signature metadata;
pure conformance passes 6/6 and the live PostgreSQL suite passes 3/3 for
retry/replay identity and scope-bound cursor tamper/expiry behavior. Pull
cursors use a tenant-global monotonic position for multi-stream subscriptions;
a per-stream position cannot safely implement one cursor. The protocol and
cursor decisions are implemented for the M2 gate.
