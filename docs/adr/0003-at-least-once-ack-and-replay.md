# ADR-0003: At-least-once acknowledgement and replay

- Status: Accepted and implemented in the M2 repository
- Date: 2026-08-18
- Scope: Webhook, pull, retry, dead-letter, and replay semantics

## Context

Agent Feed cannot guarantee exactly-once effects across an external HTTP
boundary. A consumer may commit a receipt and lose the response, or Agent Feed
may retry after a timeout. The same event must therefore be safe to deliver
more than once.

The protocol event already contains an immutable `event_id` and a required
`attempt` field. The attempt is part of the signed body, so retrying changes
the raw body and signature. The source event identity (`event_id`, payload,
`occurred_at`, and payload hash) remains immutable while the delivery envelope
is re-encoded for each attempt.

## Decision

- External delivery is at-least-once.
- A consumer deduplicates by `event_id` and records its receipt durably before
  returning webhook `2xx` or pull acknowledgement success.
- Agent Feed stores attempt history separately from the immutable outbox event
  and re-encodes the protocol body with the current attempt number before
  signing.
- Retries use a bounded deterministic exponential schedule. Any jitter is
  injectable and testable.
- After the configured maximum, an attempt enters dead-letter state with its
  last error, trace lineage, and attempt history intact.
- Replay keeps the original event ID, payload, occurred time, and payload hash,
  records operator/replay reason, and creates a new monotonically numbered
  attempt. It signs the new body containing that attempt; it never overwrites
  the immutable source event or deletes previous failures.
- Acknowledgement and replay commands are idempotent within their scoped
  consumer/subscription.

## Rejected alternatives

- Claim exactly-once HTTP delivery: impossible to prove across the boundary.
- Generate a new event ID for every retry: breaks consumer deduplication and
  makes replay appear to be a new finding.
- Delete dead letters after replay: destroys the audit trail.
- Treat any 2xx as proof of a consumer database commit: the receiver owns that
  durability guarantee.

## Consequences

Consumers must implement an event receipt table or equivalent idempotency
store. Operators can replay without changing producer truth, but replay must be
authorized and audited. Metrics must distinguish attempts, successful event
delivery, acknowledgement, and replay.

## Validation

- fake receiver outage/recovery test;
- duplicate webhook test with one consumer receipt;
- deterministic retry schedule test;
- max-attempt dead-letter test;
- replay test proving same event ID/payload hash and incremented body attempt;
- acknowledgement retry and wrong-consumer rejection tests.

## Implementation review — 2026-08-18

Pure conformance passes 6/6 and the live PostgreSQL suite passes 3/3,
covering at-least-once retry/recovery, lease transitions, acknowledgement,
dead-letter, replay, and signed cursor behavior. The worker composition remains
transport-injected; a production process/deployment is future operational
work, not an unresolved protocol decision.
