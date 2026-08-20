# Milestone 7 — occurrence ledger and liveness correctness

Status: **local implementation, live PostgreSQL acceptance, independent
re-review, the full M0–M6 local regression, and hosted CI green on draft PR
#9**

Milestone 7 makes recurring-run liveness derive from immutable nominal
occurrences instead of terminal completion time. Agent Feed remains a proof
and control plane; it is not a scheduler, executor, workflow builder, or
provider-specific automation service.

## Boundaries

`packages/occurrence-core` owns pure validation, bounded materialization,
matching decisions, invocation outcomes, misfire classification, and overlap
classification. Interval schedules are elapsed UTC from an immutable anchor.
Cron schedules use exactly five fields, an IANA timezone, and the exact-pinned
`cron-parser@5.10.0`; materialized proof is stored as UTC.

`packages/persistence-postgres` owns additive sidecar persistence:

- immutable schedule expectation versions;
- immutable expected occurrences;
- immutable trusted run-trigger context;
- immutable one-run/one-occurrence links;
- tenant-scoped liveness reads; and
- append-only quarantine receipts for unsafe legacy attribution.

Protocol `0.1` remains immutable. No occurrence, trigger, schedule, or matching
field is added to its nine schemas or three lifecycle tools. Producer-supplied
metadata cannot declare a run scheduled. A server-side scheduler or adapter
must write trusted trigger context through the dedicated repository boundary.

## Correctness model

A scheduled zero-finding completed run satisfies exactly one occurrence. A
running invocation proves arrival but not completion. Partial, failed, and
cancelled invocations remain distinct from absence. Manual, test, retry,
replay, backfill, event, and unknown triggers cannot satisfy or advance a
scheduled occurrence.

Explicit matching names one occurrence in the same schedule version.
Windowed and legacy matching use the run start time and require exactly one
candidate. Duplicate and ambiguous matches fail closed in both repository and
database constraints. Fixed cadence uses nominal timestamps, never completion
time, so a delayed run cannot drift later occurrences.

Legacy `stream_expectations` remain readable for protocol compatibility. The
new migration copies only a safely attributable version-1 baseline and never
fabricates historical occurrences or links. Streams with non-default tenant
activity enter deterministic quarantine because their old rows lack tenant
identity.

## Acceptance

The milestone command is:

```sh
AGENT_FEED_DATABASE_URL=postgresql://... npm run m7:conformance
```

It requires a disposable live PostgreSQL database. `--unit-only` is useful for
development but is not acceptance. The gate builds and tests the pure core and
PostgreSQL packages, reruns protocol compatibility, and exercises migration,
tenant isolation, append-only rows, trusted provenance, fixed cadence,
timezone/DST, misfire/overlap, outcome liveness, ambiguity, and concurrent
duplicate matching.

Hosted CI runs the same command from a clean checkout. Complete acceptance also
requires the existing M0–M6 CI jobs to remain green.

On 2026-08-20 the combined command passed against a fresh disposable local
PostgreSQL database with 9 architecture boundaries, 11 pure-core tests, 14
persistence tests with zero skips, and protocol `0.1` compatibility green.
An independent verifier reran that live gate, found no blocker or high-severity
finding, and recommended acceptance. The full M0–M6 local regression also
passed, including all required live PostgreSQL suites. Clean-checkout GitHub
Actions run
[32307120427](https://github.com/wesleykao1990/agent-feed/actions/runs/32307120427)
then passed the complete five-job M0–M7 matrix on draft PR #9.

## Explicit non-claims

This milestone does not invoke jobs, acquire scheduler leases, provide a
calendar/RRULE engine, add provider-specific cron extensions, or expose
trigger classification to untrusted producer HTTP or MCP calls. It does not
replace the legacy liveness API, and legacy completion-time projections are
not authoritative for new occurrence reads.

No Rewards Optimizer code or database is part of this milestone.
