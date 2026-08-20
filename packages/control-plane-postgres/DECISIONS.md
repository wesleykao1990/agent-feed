# Decisions

## M10 PostgreSQL read boundary

- Query immutable source tables directly; do not create a second mutable
  control-plane ledger.
- Use one repeatable-read, read-only transaction so cross-domain totals share
  one database snapshot.
- Require an explicit observation window in the public snapshot contract.
- Count only sealed assessments and the latest definition version per job key.
- Return aggregate state/count rows only; payload and diagnostic columns are
  outside the adapter's selectable inventory.
- Treat failure-layer counts as independent operational signals rather than a
  mutually exclusive causal taxonomy.
