# Operations-core learnings

- A retention worker must receive immutable metadata, not protocol payloads.
  This keeps policy decisions testable and avoids coupling deletion to the
  wire schema.
- `retainUntil` is an absolute override, while ordinary rules age from the
  terminal time. This lets legal/privacy workflows extend retention without
  changing the global policy version.
- “Delete expired” is not safe for a schema whose accepted records are
  append-only. Only explicitly managed external artifacts are candidates in
  this slice; protocol rows, delivery receipts, and liveness history remain
  protected. A future archival design must explicitly handle dependencies,
  object-storage artifacts, audit evidence, and database triggers.
- Deterministic NDJSON is useful as both an operator artifact and a compact
  verification input: the exact byte hash can be stored beside the export.
- A signed-looking plan ID is not an authorization check by itself. The
  execution boundary must recompute it from the complete plan after validating
  candidates, then let the transactional adapter re-check current state.
- Bounds should be enforced while constructing the artifact, not only by a
  caller-side convention; otherwise large audit exports and retention batches
  can turn an operator path into an unbounded resource consumer.
- Deterministic ordering needs a total tie-breaker. Domain IDs and timestamps
  can legitimately repeat across audit events, while canonical normalized
  bytes define a stable final order without trusting query order.
- Sensitive-field filtering needs both structural and lexical checks. Key
  allow-lists alone miss signed URLs and credentials placed under names such
  as `note` or `reference`.
