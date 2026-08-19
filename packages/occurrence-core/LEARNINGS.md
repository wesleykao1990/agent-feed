# Occurrence-core learnings

## M7-OC-L001 — Nominal cadence is the liveness clock

Intervals must be generated from an immutable anchor and ordinal index. Using
the prior run's completion timestamp makes a delayed invocation permanently
shift future expectations and turns execution latency into schedule state.

## M7-OC-L002 — UTC keys and local display are different concerns

Cron schedules need an IANA timezone to interpret wall-clock fields, but keys,
range comparisons, windows, and persistence should use canonical UTC instants.
The DST fixtures are intentionally asserted as UTC bytes.

## M7-OC-L003 — A bounded iterator is part of correctness

Cron-parser can iterate indefinitely over a long range and a dense interval can
produce millions of candidates. A hard limit must be checked before every
generation path, including disabled expectations and catch-up classification.

## M7-OC-L004 — Trigger provenance is not execution status

`completed` with zero findings proves a scheduled invocation only when trigger
and occurrence matching succeed. A manual completed run, or a scheduled run
outside its matching window, must not be treated as scheduled success.
