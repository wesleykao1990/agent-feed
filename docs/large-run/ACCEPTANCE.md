# Large-run scaling acceptance

Status: **pure TypeScript SDK checkpoint accepted locally; live scale pending**

- 250 finding/evidence units plan as bounded `100 / 100 / 50` batches.
- serialized body-byte limits split between units and reject one oversized unit.
- duplicate IDs and forward/missing evidence references fail closed.
- repeated identical input produces byte-equal requests and identities.
- sequential submission reports a checkpoint only after each accepted receipt.
- completion is neither synthesized nor called by the helper.
- live PostgreSQL stores 3 batches, 250 findings, and 250 evidence records,
  reconciles terminal counts, and accepts the regenerated batches as exact
  retries after completion.

Focused evidence: `npm run build` and `npm test` in
`packages/sdk/typescript` pass, including the ordinary packed-consumer smoke.
Run the complete local gate with `AGENT_FEED_DATABASE_URL=... npm run
large-run:conformance`. Hosted CI must still pass before broader release
acceptance.

## Local integrated evidence — 2026-08-21

- `large-run:conformance`: SDK build/test/pack, protocol compatibility, and
  live 250-unit PostgreSQL proof passed with no skips.
- `m2:conformance`: complete delivery and 20-test persistence suite passed
  against PostgreSQL, including the additive Milestone 12 migration.
- `m3:conformance`: architecture, API/MCP/adapters, TypeScript package/pack,
  Python tests/wheel/external import all passed with no skips.
- `m12:conformance`: utility core/service and live PostgreSQL persistence
  passed with no skips.
- managed foundation validation, generated types, protocol compatibility,
  checksum verification, and `git diff --check` passed.
