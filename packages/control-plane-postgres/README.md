# `@agent-feed/control-plane-postgres`

Read-only PostgreSQL adapter for `@agent-feed/control-plane-core`. It derives
one payload-free snapshot inside a `REPEATABLE READ READ ONLY` transaction and
binds every source query to one validated tenant and explicit observation
window.

The adapter counts the latest immutable definition for each logical job,
expected occurrences, protocol runs, sealed assessments, and delivery queue
rows. Completed occurrences with no findings remain distinct from missing
occurrences. It never selects protocol envelopes, finding/evidence bodies,
assessment summaries, delivery error details, signatures, references, or
metadata.

Failure counters are operational signals, not mutually exclusive root-cause
attribution:

- provider: sealed assessments classified as provider or rate-limit failures;
- gateway: sealed authentication, authorization, or network failures;
- execution: failed or cancelled protocol runs;
- validation: failed or inconclusive sealed assessments; and
- delivery: retry-wait or dead-letter delivery rows.

The default observation window is 24 hours and can be set from 60 seconds to
30 days. The database transaction clock is authoritative unless a strict UTC
`asOf` is supplied for deterministic tests or replay.

This package does not expose HTTP, dashboard, identity, authorization, alert,
or deployment surfaces.
