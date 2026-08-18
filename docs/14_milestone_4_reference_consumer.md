# Milestone 4 — Generic reference consumer

Status: **local M0–M4 integrated gates green; hosted CI pending**

Started: 2026-08-18

Milestone 4 delivers the runnable, domain-neutral reference integration in
`examples/rewards-optimizer/`. The historical directory name demonstrates the
intended downstream use, but the code is not the Rewards Optimizer app and
contains no reward rules, database, review workflow, or deployment.

## Objective and boundary

```text
authenticated caller scope + Agent Feed DeliveryEvent
  -> validate protocol 0.1 and stream authorization
  -> tenant-scoped transport receipt/dedupe
  -> untrusted SourceObservation with submitted evidence
  -> tenant/consumer/stream-scoped semantic candidate key
  -> caller-owned verification and domain policy
```

The example proves the mapping boundary, not production durability. Its
in-memory receipts and observations are intentionally replaceable. A real
consumer must persist receipt/observation state before acknowledgement and
must own authentication, source verification, evidence policy, review, and
domain writes.

## Implemented modules

- `examples/rewards-optimizer/src/index.ts`: public mapper, scoped in-memory
  reference consumer, redacted typed errors, transport and semantic dedupe.
- `examples/rewards-optimizer/test/`: focused TypeScript tests.
- `tests/m4/`: public-artifact behavioral conformance and static architecture
  tests.
- `scripts/check_m4_architecture.mjs`: rejects database, SQL, Agent Feed server,
  private source-subpath, raw sensitive logging, and promotion/domain outputs.
- `scripts/run_m4_conformance.mjs`: fail-closed, zero-skip Node-only gate.

The example depends only on the TypeScript SDK through its public package
boundary. It does not import Agent Feed persistence, API, MCP, worker, or
private `/src` paths.

## Trust and identity rules

1. `finding.submitted` maps to `UntrustedSourceObservation`, never to a reward
   rule or verified fact.
2. Submitted evidence, open attributes, and security flags are cloned and
   retained as untrusted data. No source text is executed or copied to errors.
3. Transport identity is `{authenticated tenant_id, event_id}`. A retry may
   change `attempt`; reuse of the same event ID with different immutable event
   content fails closed as `transport_payload_conflict`.
4. Semantic identity is a versioned consumer key scoped to tenant, consumer,
   and stream.
   It excludes `event_id`, `attempt`, and `producer_dedupe_key`.
5. Tenant identity and the non-empty stream allowlist come from caller-owned
   authenticated context, never the delivery body.
6. Lifecycle events may be recorded as transport input but never create source
   observations.

## Acceptance matrix

The Passed rows below are local reference-consumer claims only. They do not
claim that the separate Rewards Optimizer app, webhook authentication,
production persistence, or review workflow exists.

| ID | Local acceptance requirement | Evidence | Status |
|---|---|---|---|
| M4-A01 | The built public package is importable and exposes only the generic observation surface. | Public-export conformance and `npm pack --dry-run`. | Passed |
| M4-A02 | A valid finding becomes an explicitly untrusted, non-promoted observation with lineage and evidence. | Mapping conformance and focused package test. | Passed |
| M4-A03 | Transport and semantic dedupe remain separate and retain distinct delivery lineage. | Replay and distinct-event semantic duplicate tests. | Passed |
| M4-A04 | Exact retry with changed `attempt` is idempotent; event-ID payload drift fails closed with a redacted error. | Conflict regression tests. | Passed |
| M4-A05 | Authenticated tenant, consumer, and stream scope are required; unauthorized streams fail closed and semantic keys do not cross scope. | Scope isolation tests. | Passed |
| M4-A06 | Hostile text, security flags, handling restrictions, and submitted evidence remain untrusted and unpromoted. | Hostile fixture and focused adversarial test. | Passed |
| M4-A07 | Unknown open attributes survive mapping as data rather than being interpreted as rules. | Unknown-attribute round-trip test. | Passed |
| M4-A08 | Lifecycle events do not synthesize observations. | Lifecycle conformance and focused test. | Passed |
| M4-A09 | The implementation has no database/SQL, Agent Feed server, private source, or domain-promotion dependency. | Static checker and hostile architecture fixtures. | Passed |
| M4-A10 | All prior Agent Feed gates remain green together. | Full local foundation/M1/M2/M3 regression. | Passed locally |
| M4-A11 | Hosted M4 and repository CI remain green on the candidate commit. | GitHub Actions. | Pending |

Local M4 command:

```sh
npm run m4:conformance
```

Current local result: 6 architecture tests, 10 public behavioral tests, and 9
focused package tests passed with zero skips; the package built and packed.
The integrated foundation, live PostgreSQL M1/M2, and M3 gates also passed.

## Explicitly out of scope

- implementing or changing the separate Rewards Optimizer repository;
- production receipt persistence, webhook signature verification, cursor/ACK,
  retry, dead-letter, or deployment infrastructure;
- canonical source acquisition, evidence promotion, or rule review;
- direct consumer access to Agent Feed PostgreSQL or Realtime;
- adding Rewards-specific fields to Agent Feed protocol schemas; and
- claiming external app behavior from this local reference package.

Supporting records: `docs/m4/ACCEPTANCE.md`, `BUGS.md`, `DECISIONS.md`,
`LEARNINGS.md`, and `REFACTOR_DEBT.md`.
