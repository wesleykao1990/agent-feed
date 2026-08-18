# Milestone 4 modularity and refactor-debt audit

Reviewed: 2026-08-18

## Current module boundaries

| Module | Owns | Must not own |
|---|---|---|
| `@agent-feed/sdk` | Public protocol and transport-facing types | Consumer domain policy |
| Reference mapper | Validation, cloning, untrusted observation mapping | Persistence, authentication, verification, promotion |
| Reference consumer | Scoped in-memory receipt and semantic-key demonstration | Production ACK/durability, retry, DLQ, database |
| M4 architecture gate | Static dependency and forbidden-output enforcement | Runtime business decisions |
| Downstream app | Durable receipt, authentication, verification, evidence/review/domain policy | Direct Agent Feed DB/private imports |

## Review result

- [x] One production source module with no premature internal abstraction.
- [x] Public SDK import only; no `/src`, API, MCP, worker, persistence, SQL, or
  Realtime dependency.
- [x] Transport and semantic identity are separate functions and stores.
- [x] Mapping is pure except for caller-owned in-memory state.
- [x] Errors are typed and stable without copying untrusted content.
- [x] Package builds declarations, imports through `exports`, and packs only
  intended files.
- [x] Root M4 runner is separate from the accepted M3 gate.
- [x] CI is Node-only and has no PostgreSQL service dependency.

## Accepted limitations, not refactor debt

The in-memory store is deliberately non-durable; replacing it with production
storage belongs to a downstream consumer. The default semantic fingerprint is
an example policy, versioned `v1`; a domain application may supply its own
fingerprint callback. These extension points do not justify adding storage or
domain abstractions to Agent Feed now.

## Deferred maintenance

1. If later milestones add several reference consumers, extract shared
   canonical JSON and gate-runner utilities only after real duplication exists.
2. The TypeScript and Python SDK pull views use different naming idioms; a
   future cross-SDK consumer example may add an explicit delivery-view adapter.
3. Production consumers should persist receipt and observation atomically
   before ACK, but that design must be implemented in their owning repository.
