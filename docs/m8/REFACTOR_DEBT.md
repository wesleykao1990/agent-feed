# Milestone 8 modularity and refactor-debt audit

Reviewed: 2026-08-20

| Module | Owns | Must not own |
|---|---|---|
| `packages/assessment-core` | Pure policy, request, telemetry, artifact, authority-compatibility, and hashing contracts | PostgreSQL, authentication, provider calls, validator execution |
| `persistence-postgres/src/assessment-store.ts` | Trusted tenant-safe sidecar writes and reads | Producer ingress, assessor authentication, assessment execution |
| `0005_job_proof.sql` | Immutable proof rows, composite FKs, exact vocabulary, and portable cross-row invariants | Secrets, artifact bytes, provider-specific validation logic |
| Trusted validation composition root | Authenticate the assessor and select its exact registration version | Allow a producer to self-assert independent authority |

The split is intentional and no broad refactor is currently justified. The
pure package is the only normalization and canonical-hash contract;
persistence adapts it rather than maintaining an independent policy language.
The producer lifecycle service remains unchanged. A future validator adapter
should call these boundaries and must not move execution or artifact storage
into Agent Feed.
