# Milestone 7 modularity and refactor-debt audit

Reviewed: 2026-08-20

| Module | Owns | Must not own |
|---|---|---|
| `packages/occurrence-core` | Pure schedule validation, materialization, matching, outcomes, misfire, overlap | PostgreSQL, provider calls, scheduler execution |
| `persistence-postgres/src/occurrence-store.ts` | Trusted sidecar writes, tenant-safe linking, liveness reads | Protocol ingress, cron implementation, job invocation |
| `0004_occurrence_ledger.sql` | Immutable rows, tenant FKs, uniqueness, portable cross-row invariants | Provider-specific scheduling or secret-bearing credentials |
| External scheduler adapter | Invoke work and record trusted trigger provenance | Rewriting Agent Feed proof or protocol schemas |

The split is intentional and no broad refactor is currently justified. The
pure package is the only schedule calculator; persistence adapts its result
instead of copying cron/DST policy. Trigger context is a narrow sidecar rather
than a field added to the protocol run envelope. A later scheduler integration
should call these boundaries, not move scheduling into Agent Feed.
