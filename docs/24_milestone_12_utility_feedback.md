# Milestone 12 — utility and optimization feedback

Status: **first pure contract checkpoint green locally; milestone not accepted**

Milestone 12 adds consumer-owned utility evidence without changing producer
claims or protocol `0.1`. The first checkpoint is deliberately pure: it freezes
identity, validation, idempotency, metric, and approval semantics before a
database or API is introduced.

## Disposition contract

`packages/utility-feedback-core` supports append-only `surfaced`, `ignored`,
`duplicate`, `invalid`, `saved`, `acted_on`, `promoted`, and `rejected` events.
Authenticated tenant/consumer ownership is trusted context supplied separately
from the feedback body.

Targets contain immutable identity only:

- a finding target pins stream, run, and finding IDs; or
- an artifact target pins stream, run, assessment-receipt ID, and SHA-256
  artifact digest.

The contract cannot rewrite findings, evidence, artifacts, summaries, prompts,
or schedules. Exact retries return the original record; a reused feedback key
with different content fails closed.

## Exact utility metrics

Snapshots pin job key, definition version/hash, and validation-policy version.
All counts and durations are bounded nonnegative safe integers. Review burden,
source yield, time to action, cost per accepted result, and cost per acted-on
result are exact numerator/denominator pairs. A zero denominator produces null,
not an invented zero or infinity.

Comparisons preserve the full baseline and candidate scopes and reject
different logical job keys. Definition or policy changes remain explicit rather
than being aggregated away.

## Approval boundary

Prompt and schedule suggestions carry only a proposal digest and controlled
`ref:` reference. They always begin `pending` and require separate approval
from a trusted tenant authority scoped to the owning consumer. No prompt body,
cron expression, provider credential, executable change, or application method
exists in this package.

## Protected boundaries and remaining work

- Protocol `0.1`, producer REST, and MCP lifecycle tools are unchanged.
- Feedback remains consumer-owned and is not producer or assessor truth.
- No Rewards Optimizer code, schema, database, or domain policy is included.
- The first checkpoint makes no durable, live-consumer, dashboard, hosted-CI,
  or recommendation-application claim.

Remaining slices are an append-only tenant-scoped PostgreSQL sidecar, a trusted
consumer application service, bounded aggregate projection, reference-consumer
integration, live two-consumer evidence, independent hostile review, and full
prior-milestone regression.
