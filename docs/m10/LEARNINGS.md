# Milestone 10 learnings

- Delivery health alone cannot answer whether a job was expected, invoked,
  completed, independently validated, and consumed.
- Aggregates must preserve completed-zero separately from absence or the
  control plane recreates the liveness ambiguity solved in Milestone 7.
- A read-only dashboard is only as safe as its adapter contract; payload
  rejection belongs before rendering and metric export.
