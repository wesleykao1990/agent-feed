# `@agent-feed/occurrence-core`

Pure schedule-proof primitives for Agent Feed Milestone 7. The package has no
database, queue, scheduler, executor, provider, or protocol `0.1` dependency.
It normalizes immutable versioned expectations, materializes bounded expected
occurrences, and makes matching, misfire, and overlap decisions for an adapter
or persistence worker.

## Expectations and occurrences

An expectation has an immutable `expectationId` and `expectationVersion`, a
schedule, grace window, matching mode, misfire policy, and overlap policy.
Changing cadence or policy means creating a new expectation version. Interval
cadence is elapsed UTC from its immutable `anchorAt`; it is never calculated
from the previous run's completion time, so delayed execution cannot drift the
schedule. Cron cadence uses exactly five standard fields (minute, hour,
day-of-month, month, day-of-week) and an explicit IANA timezone.

```ts
import {
  materializeOccurrences,
  normalizeExpectation,
} from "@agent-feed/occurrence-core";

const expectation = normalizeExpectation({
  expectationId: "daily-report",
  expectationVersion: "2026-08-20",
  schedule: {
    kind: "cron",
    expression: "30 9 * * 1-5",
    timezone: "Asia/Tokyo",
  },
  graceSeconds: 900,
  matchingMode: "windowed",
  misfirePolicy: "fire_latest",
  overlapPolicy: "fail_closed",
});

const materialized = materializeOccurrences({
  expectation,
  from: "2026-08-24T00:00:00Z",
  to: "2026-08-29T00:00:00Z",
});
```

Every occurrence stores a canonical UTC `expectedAt`/`nominalAt`, a UTC
`windowEndsAt`, the expectation version, and an `occurrenceKey` derived from
`expectationId`, `expectationVersion`, and nominal UTC time. Materialization is
inclusive at both range endpoints and always bounded: the caller may request
at most 10,000 occurrences. Invalid five-field grammar, macros, `?`, `L`, `W`,
`#`, `H`, unknown timezones, malformed timestamps, and unsafe limits fail
closed.

## Matching and outcomes

`matchOccurrence` accepts one run and a bounded candidate occurrence set.
Only `scheduled` runs satisfy normal interval/cron expectations. `legacy` is
accepted only for `matchingMode: "legacy"`; manual, test, retry, replay,
backfill, event, and unknown triggers are rejected. Explicit matching requires
one same-version occurrence key. Windowed and legacy matching use the inclusive
window `[expectedAt, expectedAt + graceSeconds]` and require exactly one
candidate. Ambiguity and already-linked keys fail closed. `matchInvocations`
also rejects a repeated run ID, preserving the one-run/one-occurrence invariant.

Matching proves invocation; it does not turn a failed run into success.
`deriveInvocationOutcome` distinguishes a running invocation, successful
completed run (including zero findings), partial, failed, cancelled, and
absence. A missing scheduled run remains absence rather than zero findings.

## Misfires and overlap

`classifyMisfires` receives an explicit `now` and linked-key set. `mark_missed`
selects every overdue unlinked occurrence as missed; `fire_latest` marks older
overdue occurrences missed and makes only the newest eligible; `catch_up`
makes the oldest caller-selected N eligible (N <= 100) and explicitly defers
the remainder. Linked and not-yet-overdue occurrences are returned separately.

`decideOverlap` is pure: `allow` is eligible, `skip` is suppressed (never
missed), and `fail_closed` is conflict while any prior invocation is still
invoked/running; otherwise it is eligible.

## Cron parser and DST contract

The dependency is pinned exactly to `cron-parser@5.10.0`. Its timezone iterator
is the source of truth for wall-clock conversion, while this package persists
only UTC instants. The package intentionally uses the parser's standard
five-field semantics, including the usual day-of-month/day-of-week behavior.

The pinned parser's DST behavior is covered by tests: in
`America/New_York`, `30 2 * * *` on the 2026 spring-forward date materializes as
`2026-03-08T07:30:00.000Z` (the landing instant after the skipped 02:30), and
`30 1 * * *` on the 2026 fall-back date emits the first repeated 01:30 at
`2026-11-01T05:30:00.000Z`, not a second duplicate at the later offset. A
future dependency upgrade must re-run and review these fixtures before changing
the pinned version.

This package does not implement RRULE/calendar schedules, provider-specific
extensions, persistence, leases, execution, or automatic schedule generation.
