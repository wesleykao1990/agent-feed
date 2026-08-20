# Milestone 10 bugs

| ID | Finding | Resolution |
|---|---|---|
| M10-001 | The existing dashboard contract covers delivery/retention metrics only and cannot represent job, occurrence, execution, or validation state. | Introduced a separate complete control-plane aggregate contract; dashboard integration remains a later slice. |
| M10-002 | The first aggregate draft ignored unknown top-level fields, which could silently discard payload/schema drift. | Unknown fields now fail closed; hostile evidence and authorization additions are covered by tests. |
