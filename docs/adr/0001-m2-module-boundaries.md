# ADR-0001: Milestone 2 module boundaries

- Status: Accepted and implemented in the M2 repository; deployment follow-up remains
- Date: 2026-08-18
- Scope: Agent Feed durable consumer delivery

## Context

Agent Feed currently has protocol contracts, an in-memory prototype, and a
PostgreSQL ingress package. The prototype is intentionally dependency-light;
the PostgreSQL package owns SQL and transaction behavior. Durable delivery
adds routing, queue leases, webhooks, pull cursors, retries, acknowledgements,
and metrics. Putting all of this in `prototype/src/store.ts` or
`packages/persistence-postgres/src/postgres-store.ts` would couple unrelated
concerns and make a second storage or transport adapter expensive.

There are also three canonical-JSON implementations. Adding another signer in
the worker would create protocol drift.

## Decision

Create four bounded layers:

1. `packages/protocol-runtime/` for canonical JSON and shared signing/replay
   primitives;
2. `packages/delivery-core/` for pure delivery types, ports, routing,
   backoff, and state transitions;
3. `packages/persistence-postgres/` for migrations and SQL implementations of
   delivery ports, plus the narrow ingress transaction seam;
4. `apps/delivery-worker/` and `apps/api/src/delivery/` for process and HTTP
   adapters.

The prototype remains an in-memory reference and must not become the durable
queue implementation. Generic packages cannot import Rewards Optimizer
concepts.

## Rejected alternatives

- Put queue logic in `prototype/src/store.ts`: fast initially, but it would
  make production behavior depend on a test/reference implementation.
- Put webhook calls in the PostgreSQL repository: couples storage to network
  availability and prevents deterministic unit tests.
- Let API handlers query delivery tables directly: duplicates authorization
  and isolation rules across endpoints.
- Add a second canonical JSON or HMAC implementation in the worker: creates
  incompatible hashes/signatures.

## Consequences

The first M2 implementation needs a small shared runtime package and explicit
ports. There will be more files, but each package can be built and tested in
isolation. A future queue adapter or storage backend can implement the same
ports without changing routing semantics.

## Validation

- static dependency check proves delivery-core has no `pg` or HTTP imports;
- each package builds independently;
- canonical JSON/HMAC behavior has one implementation and cross-package tests;
- fake-clock/fake-transport tests cover delivery-core without PostgreSQL;
- PostgreSQL and end-to-end tests exercise the adapters separately.

## Implementation review — 2026-08-18

The combined acceptance passes the architecture suite (4), pure conformance
(6), live PostgreSQL suite (3), all seven M2 package/application clean
installs/builds/tests, and the package-specific evidence. The worker remains a
composition boundary without a production process/CLI entrypoint, and the API
remains transport-neutral without an HTTP server. The in-memory prototype may
retain historical protocol helpers; production cross-package edges use
declared package names/public exports. This ADR is implemented for the M2 gate.
