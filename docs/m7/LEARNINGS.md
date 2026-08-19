# Milestone 7 learnings

## M7-L001 — Completion is not cadence

Nominal occurrence time is stable schedule identity. Recomputing the next due
time from completion converts execution delay into permanent schedule drift.

## M7-L002 — Trigger classification is security-relevant provenance

A string supplied on the same command that creates a proof link cannot prove
that invocation came from a scheduler. Trigger context needs a durable,
trusted, server-side boundary that protocol producers cannot call.

## M7-L003 — Pure validation and durable proof need an explicit bridge

A well-tested schedule package is insufficient if persistence accepts a
different grammar or arbitrary timestamps. The adapter must invoke the pure
calculator and the database should recheck every portable invariant.

## M7-L004 — Database constraints close alternate write paths

Repository transactions provide friendly deterministic errors. Composite
foreign keys, uniqueness, append-only triggers, and cross-row validation keep
direct or future adapter writes from silently weakening occurrence proof.

## M7-L005 — Legacy ambiguity is evidence, not a migration inconvenience

An unscoped legacy expectation used by multiple tenants has no correct
automatic owner. A quarantine receipt is more accurate than a guessed row.

## M7-L006 — DST behavior belongs in the versioned calculator contract

Cron wall-clock behavior changes at nonexistent and repeated local times. An
exact parser version plus explicit spring/fall fixtures makes that behavior
reviewable and prevents a dependency update from silently changing proof.

## M7-L007 — Acceptance failures need environment classification

A loopback bind denied by the execution sandbox is not equivalent to a failed
HTTP contract. Preserve the failed receipt, rerun the unchanged test with the
minimum required local capability, and claim success only from that passing
run.
