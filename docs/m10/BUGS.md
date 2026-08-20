# Milestone 10 bugs

| ID | Finding | Resolution |
|---|---|---|
| M10-001 | The existing dashboard contract covers delivery/retention metrics only and cannot represent job, occurrence, execution, or validation state. | Introduced a separate complete control-plane aggregate contract; dashboard integration remains a later slice. |
| M10-002 | The first aggregate draft ignored unknown top-level fields, which could silently discard payload/schema drift. | Unknown fields now fail closed; hostile evidence and authorization additions are covered by tests. |
| M10-003 | An unbounded aggregate would keep old absences and dead letters active forever. | Added a required observation window to the public contract and all time-varying SQL. |
| M10-004 | Counting every immutable definition version overstates the number of logical jobs. | The PostgreSQL query selects the latest version of each tenant/job key before aggregation. |
| M10-005 | The initial PR had no dedicated hosted M10 job. | Added a PostgreSQL-backed `milestone-10-control-plane` workflow job; a hosted result still requires publication. |
| M10-006 | The first full-regression run selected system Python 3.14 without `setuptools.build_meta`, so M3 could not build its wheel. | Repeated the unmodified M3 gate under the supported Python 3.12 toolchain with pip, setuptools, and wheel in a disposable environment; it passed. |
| M10-007 | Nested failure and count-group objects initially ignored unknown fields even though the root contract failed them closed. | Extended runtime validation and hostile tests so nested payload-shaped drift is rejected too. |
