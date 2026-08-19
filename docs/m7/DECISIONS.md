# Milestone 7 decision log

Started: 2026-08-20. This log is append-only.

| ID | Decision | Reason | Verification |
|---|---|---|---|
| M7-D001 | Keep protocol `0.1` immutable and add occurrence proof as versioned sidecars. | Schedule semantics are not yet universal across providers. | Protocol compatibility and architecture guards. |
| M7-D002 | Keep occurrence calculation and policy decisions in a pure package; PostgreSQL persists their proof. | Schedulers and storage adapters need one deterministic contract without making Agent Feed an executor. | Package dependency and persisted-materialization fixtures. |
| M7-D003 | Use immutable UTC anchors for intervals and exact-pin `cron-parser@5.10.0` for bounded five-field cron with IANA timezones. | Completion-based cadence drifts; parser and DST behavior must be reviewable. | Drift, grammar, spring-forward, and fall-back fixtures. |
| M7-D004 | Bound materialization at 10,000 occurrences and catch-up at 100. | Dense schedules and large ranges must fail closed instead of exhausting a process or transaction. | Limit regressions. |
| M7-D005 | Persist trusted trigger context separately from protocol runs and links. | Producer metadata and a link command must not self-declare a run scheduled. | Missing/manual context rejection and exact-retry/conflict tests. |
| M7-D006 | Link at invocation time and derive current execution outcome by joining the run. | Invocation failure is evidence of arrival, while absence means no invocation. | Running/completed-zero/partial/failed/cancelled/absence fixtures. |
| M7-D007 | Quarantine ambiguous legacy ownership and migrate no historical occurrence links. | Old stream expectations lack tenant and run identity; guessing would invent proof. | Live migration fixtures. |
| M7-D008 | Treat overlap skip as suppression only when an active invocation exists. | Without an actual overlap, there is nothing to suppress. | Active/no-active policy matrix. |
