# Milestone 9 — portable job registry and capability profiles

Status: **local live implementation and complete M0–M9 regression green;
independent review and hosted CI pending**

Milestone 9 adds an immutable registry sidecar without changing producer
ingress. Protocol `0.1` remains immutable. Agent Feed records definitions,
capability evidence, deployment bindings, and preflight receipts; it does not
schedule, execute, activate, or reconfigure external jobs.

## Boundaries

`packages/job-registry-core` owns pure normalization, canonical hashing,
secret rejection, capability-version comparison, and activation preflight.
It separates three immutable version streams:

- logical job definitions containing owner, lifecycle, instruction digest or
  controlled reference, validation-policy reference, requirements, output
  contracts, and declared budgets;
- provider capability profiles; and
- deployment bindings containing scheduler/executor/ingress topology, exact
  profile-version pins, off-switch reference, and shadow evidence.

This means one logical job retains its identity and history when moved between
providers. A move appends a binding version; it does not manufacture a new job.

`packages/persistence-postgres` adds migration `0006_job_registry.sql`.
Definition, profile, and binding rows are tenant-scoped and append-only.
Canonical documents are hashed and checked against projected columns. The
database re-evaluates exact profile existence, topology providers, capability
availability/version, sealed independently passed assessments, and autonomous
activation prerequisites, so direct SQL cannot bypass repository preflight.

Definitions contain no secrets and no instruction bodies. Only a lowercase
SHA-256 digest and optional controlled `config://`, `vault-ref://`,
`git+https://`, or `object://` reference are accepted. Metadata recursively
rejects credential-shaped keys/values, inline/base64 material, signed-query
URLs, unsafe numbers, and excessive structure.

## Activation gate

An `active` deployment requires all of the following:

- an active immutable definition with an owner;
- an exact validation-policy version;
- at least one declared budget;
- a controlled off-switch reference;
- at least one sealed, passed, independently assessed shadow receipt; and
- compatible exact-pinned provider capability profiles.

Activation state is an Agent Feed proof record, not authority to call a
provider control API. External activation remains an operator-owned action.

## Acceptance

```sh
AGENT_FEED_DATABASE_URL=postgresql://... npm run m9:conformance
```

The command runs the architecture guard, pure core build/tests, complete live
PostgreSQL persistence suite, and protocol compatibility. `--unit-only` is a
development aid and cannot establish durable acceptance. Exact receipts are
recorded in `docs/m9/ACCEPTANCE.md`.

On 2026-08-20 the combined command passed against isolated database
`agent_feed_m9_20260820_root`: 10 architecture boundaries, 6 core tests, 19
live persistence tests with zero skips, and protocol `0.1` compatibility were
green. The complete M0–M9 local regression, clean installs, and checksum gate
then passed. Independent review and hosted CI remain acceptance gates.

No Rewards Optimizer code or database is part of this milestone.
