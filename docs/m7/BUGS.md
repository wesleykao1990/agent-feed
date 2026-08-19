# Milestone 7 bug and gap log

Started: 2026-08-20. This log is append-only.

| ID | Symptom / impact | Resolution and regression | Status |
|---|---|---|---|
| M7-001 | Legacy liveness advances cadence from every terminal completion, so delayed/manual runs can drift its projection. | New schedules use immutable materialized occurrences; legacy tables remain compatibility-only. | Resolved by sidecar boundary. |
| M7-002 | The first core overlap implementation suppressed `skip` even when no prior invocation was active. | Check active overlap first; add the full active/no-active policy matrix. | Resolved. |
| M7-003 | The first PostgreSQL checkpoint accepted arbitrary occurrence keys/times/windows and cron expressions that the pinned core rejected. | Persistence now consumes occurrence-core, derives or verifies materialization, checks deterministic keys/windows/interval alignment in SQL, aligns cron guards, and runs hostile fixtures. | Resolved; local live regression green. |
| M7-004 | The first link command accepted caller-selected `trigger_kind`, so an ordinary run could claim scheduled provenance. | Immutable trusted trigger context now sits outside protocol ingress; links derive and cross-check it. | Resolved; missing/non-scheduled/exact-retry/conflict fixtures green. |
| M7-005 | The first database link trigger did not independently enforce window matching or stream identity. | The database validator joins run, expectation, occurrence, and trusted context, then rejects stream mismatch and out-of-window non-explicit links. | Resolved; repository and direct-SQL regressions green. |
| M7-006 | The first core-to-persistence cron bridge used a property name the core did not recognize, so live DST materialization failed. | Pass `timezone` under the frozen core shape and retain strict type/build coverage. | Resolved; live DST fixture green. |
| M7-007 | The first ambiguity fixture started at 01:30 while the second window began at 02:00, so it expected rejection without an actual overlap. | Move the run to 02:30, inside both persisted windows. | Resolved; ambiguity regression green. |
| M7-008 | Exact-time cron replay did not reproduce the pinned parser's spring-forward landing instant. | Validate cron instants by replaying a bounded 48-hour window, which remains below the 10,000 occurrence cap even at one-minute cadence. | Resolved; spring-forward persistence fixture green. |
| M7-009 | The first full M3 regression attempt failed because its local HTTP fixture could not bind `127.0.0.1` inside the filesystem sandbox. | Rerun the unchanged suite with approved loopback access and distinguish environment denial from a product regression. | Resolved; complete M3 gate green. |
