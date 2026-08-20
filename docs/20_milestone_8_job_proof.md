# Milestone 8 — independent job proof and operational receipts

Status: **accepted and merged through PR #10 after local live acceptance,
independent hostile re-review, complete M0–M8 regression, and hosted CI**

Milestone 8 adds immutable validation policy and assessment proof without
changing a producer run or collapsing execution and quality into one success
flag. Agent Feed remains the proof and control plane; it does not become a
validation workflow engine, model evaluator, or artifact store.

## Boundaries

`packages/assessment-core` owns pure validation, normalization, canonical
request hashing, policy-authority compatibility, explicit telemetry state,
and safe hashed artifact references. It has no PostgreSQL, network, provider,
or protocol-ingress dependency.

Agent Feed stores artifact identity and provenance rather than blobs.

`packages/persistence-postgres` owns the additive proof sidecar:

- immutable validation policy versions;
- immutable trusted assessor registration versions;
- immutable run assessment receipts;
- declared budget rows;
- usage observations with explicit state and provenance; and
- hashed artifact identity/provenance references without blob content.

Protocol `0.1` remains immutable. Producer REST and MCP continue to expose
only `begin_run`, `submit_batch`, and `complete_run`. Policy management,
assessor registration, and assessment submission are trusted operator or
validation-service composition-root capabilities, not producer tools.

## Correctness model

An assessment submission contains its assessment kind and verdict, typed
failure stage/class, stop reason, timestamps, bounded summary/metadata,
budgets, usage, and artifact references. It cannot supply assessor identity,
type, independence, or technical run status. The trusted boundary selects one
exact immutable assessor registration version, and persistence derives its
authority snapshot from that row. A producer self-check is always `self` and
cannot satisfy a policy that requires independent proof.

Technical run status is read only from the tenant-scoped persisted run.
Quality remains a separate assessment verdict, so a technically completed run
can fail quality and a failed run remains technically failed regardless of an
assessment. Reassessment appends a new receipt for the same run and exact
policy version; it never updates the run or earlier proof.

Observed usage requires a nonnegative value and non-unknown provenance.
Unknown and not-applicable telemetry require a null value, so missing data is
never converted to zero. Declared budgets follow the same explicit-state
model. Artifact rows contain a bounded kind/key, lowercase SHA-256 identity,
optional byte length/media type, and bounded provenance/reference fields;
they never contain inline blobs, base64 content, credentials, or signed URLs.

## Acceptance

The milestone command is:

```sh
AGENT_FEED_DATABASE_URL=postgresql://... npm run m8:conformance
```

It requires a disposable live PostgreSQL database. `--unit-only` is useful for
development but is not acceptance. The gate builds and tests the pure core and
PostgreSQL packages, reruns protocol compatibility, and exercises migration,
tenant isolation, trusted assessor provenance, policy independence,
idempotency conflict detection, reassessment, technical/quality separation,
explicit unknown telemetry, artifact references, and append-only rows.

Hosted CI must run the same command from a clean checkout. Complete acceptance
also requires the existing M0–M7 jobs to remain green. Exact local and hosted
receipts belong in `docs/m8/ACCEPTANCE.md`; this document must not claim them
before those commands actually pass.

On 2026-08-20 the combined command passed against fresh disposable local
PostgreSQL database `agent_feed_m8_20260820_builder`: 10 architecture
boundaries, 7 assessment-core tests, 17 persistence tests with zero skips, and
protocol `0.1` compatibility were green. Independent review, the complete
prior-milestone regression, checksums, and hosted CI remain acceptance gates.

Independent review then found that direct SQL could append child rows after a
parent receipt committed and could bypass safe-integer and artifact-secret
validation. That first green run is retained as a pre-hardening receipt, not
final acceptance. The milestone now requires an atomic receipt seal plus
hostile direct-SQL re-acceptance.

Commit `b992d3c` implemented that seal and the database-side validation. The
hardened combined gate then passed with 10 architecture boundaries, 7 core
tests, 17 live persistence tests with zero skips, and unchanged protocol
compatibility. Independent hostile re-review found no remaining blocker/high
and recommended acceptance. The complete M0–M8 local regression is green;
GitHub Actions run 32331835983 passed the complete six-job hosted matrix.

## Explicit non-claims

This milestone does not execute validators, fetch artifact bytes, judge model
quality automatically, expose assessor authority to protocol producers, or
provide a mutable “latest result” record. A deployment must give trusted
policy/assessor operations a restricted composition root and database role;
the ordinary producer role must not receive those capabilities.

No Rewards Optimizer code or database is part of this milestone.
