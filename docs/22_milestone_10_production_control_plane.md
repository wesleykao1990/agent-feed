# Milestone 10 — production control plane

Status: **contract, local live PostgreSQL projection, and complete local M0–M10
regression green; dedicated M10 hosted gate added but not yet run; dashboard
integration, durable external identity, hosted deployment, alerts, runbooks,
independent review, and final acceptance pending**

Milestone 10 turns the existing proof layers into a production-operable,
tenant-scoped read surface. It does not relax protocol `0.1`, expose payloads
to metrics, make the dashboard writable, or treat local PostgreSQL/tunnels as
hosted production evidence.

## First checkpoint — sanitized read-model contract

`packages/control-plane-core` defines a pure v1 aggregate spanning:

- immutable job lifecycle states;
- occurrence states, including distinct absence and completed-zero outcomes;
- run execution states;
- assessment verdicts;
- delivery queue/lease/retry/acknowledgement/dead-letter states; and
- separate provider, gateway, execution, validation, and delivery failures.

Every count is a bounded nonnegative safe integer and must reconcile to its
group total. Tenant scope, snapshot freshness, and an explicit observation
window are mandatory. Unknown fields
fail closed, preventing findings, evidence, artifacts, prompts, URLs,
credentials, and raw diagnostic text from entering the aggregate contract.

This package performs no database, network, OAuth, dashboard, alert, or
deployment work.

## Second checkpoint — PostgreSQL projection and hosted gate

`packages/control-plane-postgres` derives the contract from immutable M7–M9
source rows inside one `REPEATABLE READ READ ONLY` transaction. Every query is
bound to one validated tenant. Time-varying aggregates use the observation
window disclosed in the returned snapshot; job counts select only the latest
immutable version of each logical job key.

The query inventory returns state/count rows only. It does not select protocol
envelopes, finding or evidence payloads, assessment summaries, metadata,
delivery diagnostics, signatures, or controlled references. Only sealed
assessment receipts are visible. A live PostgreSQL fixture proves tenant
isolation and preserves completed-zero separately from absence.

`.github/workflows/ci.yml` now has a dedicated `milestone-10-control-plane`
job that clean-installs the dependency chain and runs `npm run
m10:conformance` against PostgreSQL 16. Adding the workflow is not a hosted
receipt; that claim requires a published commit and completed GitHub Actions
run.

## Remaining slices

1. Read-only operator dashboard projection and authenticated tenant context.
2. Durable external OAuth/OIDC verifier with persistent revocation/rotation;
   the M6 embedded provider remains explicitly memory-only.
3. Stable HTTPS deployment reference, production metrics and alert policies,
   recovery runbooks, and explicit hosted receipts/non-claims.
4. Independent hostile review and hosted CI; the complete local M0–M10
   regression is green.

No Rewards Optimizer code or database is part of this milestone.
