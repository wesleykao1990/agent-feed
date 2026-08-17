# ADR-0003: At-least-once acknowledgement and replay

- Status: Accepted for implementation; code not yet complete
- Date: 2026-08-18
- Scope: Webhook, pull, retry, dead-letter, and replay semantics

## Context

Agent Feed cannot guarantee exactly-once effects across an external HTTP
boundary. A consumer may commit a receipt and lose the response, or Agent Feed
may retry after a timeout. The same event must therefore be safe to deliver
more than once.

The protocol event already contains an immutable `event_id` and an `attempt`
field. Those fields can carry transport identity and monotonically increasing
delivery-attempt information without changing the domain meaning of a finding.

## Decision

- External delivery is at-least-once.
- A consumer deduplicates by `event_id` and records its receipt durably before
  returning webhook `2xx` or pull acknowledgement success.
- Agent Feed stores attempt history separately from the immutable outbox event.
- Retries use a bounded deterministic exponential schedule. Any jitter is
  injectable and testable.
- After the configured maximum, an attempt enters dead-letter state with its
  last error, trace lineage, and attempt history intact.
- Replay keeps the original event ID, records operator/replay reason, and
  creates a new monotonically numbered attempt. It never overwrites the event
  body or deletes previous failures.
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
- replay test proving same event ID and incremented attempt;
- acknowledgement retry and wrong-consumer rejection tests.
