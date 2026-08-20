# Milestone 10 — production control plane

Status: **first local contract checkpoint green; PostgreSQL composition,
dashboard integration, durable external identity, hosted deployment, alerts,
runbooks, independent review, and hosted CI pending**

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
group total. Tenant scope and snapshot freshness are mandatory. Unknown fields
fail closed, preventing findings, evidence, artifacts, prompts, URLs,
credentials, and raw diagnostic text from entering the aggregate contract.

This package performs no database, network, OAuth, dashboard, alert, or
deployment work. The PostgreSQL adapter must derive its snapshot from
tenant-scoped immutable source rows. The dashboard and alert exporter will
consume that same sanitized contract.

## Remaining slices

1. PostgreSQL query adapter with bounded tenant-scoped queries and direct-SQL
   fixtures across M7–M9 sidecars.
2. Read-only operator dashboard projection and authenticated tenant context.
3. Durable external OAuth/OIDC verifier with persistent revocation/rotation;
   the M6 embedded provider remains explicitly memory-only.
4. Stable HTTPS deployment reference, production metrics and alert policies,
   recovery runbooks, and explicit hosted receipts/non-claims.
5. Complete M0–M10 regression, independent hostile review, and hosted CI.

No Rewards Optimizer code or database is part of this milestone.
