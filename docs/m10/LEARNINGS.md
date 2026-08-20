# Milestone 10 learnings

- Delivery health alone cannot answer whether a job was expected, invoked,
  completed, independently validated, and consumed.
- Aggregates must preserve completed-zero separately from absence or the
  control plane recreates the liveness ambiguity solved in Milestone 7.
- A read-only dashboard is only as safe as its adapter contract; payload
  rejection belongs before rendering and metric export.
- A sanitized return type does not prevent a data adapter from reading secrets;
  the SQL inventory needs its own negative selection contract.
- Cross-domain aggregates must share a database snapshot. Independent
  autocommit reads can reconcile individually while describing different
  moments.
- Assessment completeness is defined by its receipt seal, so operational reads
  must use the same sealed boundary as registry and retry workflows.
- Full-regression receipts must name the interpreter/toolchain when a package
  build depends on it; a host's newest Python is not automatically the
  repository's supported Python.
