# Bugs encountered

- Treating missing telemetry as zero would make providers with no reporting
  appear cheaper or faster. The exact metric inventory requires explicit
  `unknown` null observations.
- Comparing only provider names allows two receipts for one deployment shape
  to satisfy the topology gate. Distinctness includes scheduler, executor,
  ingress, and deployment-binding hash.
- The first TypeScript build tried to mutate a public readonly coverage type.
  Matrix construction now uses a private mutable accumulator and returns the
  readonly public shape.
- The schema package's generated JSON declaration imports are checked by its
  own gate but are incompatible with downstream NodeNext declaration checking
  under TypeScript 7. The package now follows the MCP server precedent and
  skips only transitive declaration checking while retaining strict checks for
  its own source and tests.
- An empty local-file batch is invalid under protocol `0.1`. The offline
  fixture now carries one non-sensitive synthetic evidence record and matching
  completion counts.
- Delimiter-joined topology keys can collide when provider keys contain the
  delimiter. Matrix identity now serializes typed tuples instead.
- A frozen receipt root still left nested proof and telemetry values mutable at
  runtime. Normalization now freezes every nested contract object and array.
- A local generated schema `dist` directory masked a clean-checkout dependency
  ordering gap. The root M11 runner now builds the schema artifact before the
  provider-conformance TypeScript build, and the architecture guard requires
  that step.
