# Milestone 8 acceptance record

Status: **accepted locally and independently; complete M0–M8 hosted matrix
green on draft PR #10**

Required evidence:

- assessment-core clean install, build, and focused tests;
- persistence clean install, build, and complete live PostgreSQL suite;
- migrations `0001` through `0005` applied twice;
- producer self-check and caller-supplied authority rejection;
- exact retry, payload drift, reassessment, tenant, and direct-SQL fixtures;
- technical completion and quality verdict queried separately;
- explicit unknown telemetry and safe hashed artifact-reference fixtures;
- protocol `0.1` compatibility and checksum gates;
- complete M0–M7 regression; and
- clean-checkout GitHub Actions evidence.

Do not replace this pending statement until every claimed command has passed
without a required live-database skip. Append local, independent-review, and
hosted receipts below when they exist.

## Local receipt — 2026-08-20

Against fresh disposable database `agent_feed_m8_20260820_builder` on the
local PostgreSQL acceptance cluster:

- `npm run m8:architecture` passed 10 boundaries;
- assessment-core build and 7/7 tests passed;
- persistence build and 17/17 tests passed with zero skips;
- migrations `0001` through `0005` applied twice;
- trusted authority, self-check rejection, exact retry, payload drift,
  reassessment, run-status separation, unknown usage, artifact round-trip,
  tenant, and append-only fixtures passed;
- the existing M2 and M7 live persistence regressions passed in the same
  package run; and
- protocol `0.1` compatibility and generated-type drift checks passed.

The exact combined command was `npm run m8:conformance` with
`AGENT_FEED_DATABASE_URL` set. No live test was skipped. Independent review,
the complete M0–M7 regression, checksum update, and hosted CI remain pending.

## Independent review correction — 2026-08-20

The first live suite did not cover post-commit child inserts, fractional direct
SQL telemetry, or credential-shaped artifact metadata. Independent review
reproduced all three against fresh database
`agent_feed_m8_20260820_verifier` and recommended **FIX**. Therefore the local
receipt above is retained as an execution record but does not constitute final
acceptance. A new zero-skip receipt and independent re-review are required
after atomic receipt sealing and database-side hostile validation land.

## Hardened local receipt — 2026-08-20

Commit `b992d3c` added atomic immutable receipt seals, required each parent to
be sealed by commit, restricted reads to sealed receipts, rejected post-seal
child inserts, and enforced safe-integer and artifact-content/credential
checks in PostgreSQL.

Against fresh disposable database `agent_feed_m8_20260820_sealing`:

- `npm run m8:architecture` passed 10 boundaries;
- assessment-core build and 7/7 tests passed;
- persistence build and 17/17 tests passed with zero skips;
- late budget, usage, and artifact inserts failed after sealing;
- an unsealed parent failed at commit;
- fractional budget/usage, oversized artifact size, credential-shaped
  metadata, and URL userinfo failed through direct SQL;
- exact retry, reassessment, technical/quality separation, M2 delivery, and M7
  occurrence persistence regressions remained green; and
- protocol `0.1` compatibility passed.

Pre-seal rows from the unreleased initial M8 draft are intentionally left
unsealed and are not returned; the migration does not silently bless
incomplete aggregates.

## Independent re-review — 2026-08-20

The verifier applied migrations `0001` through `0005` and reapplied `0005` on
fresh database `agent_feed_m8_20260820_reverify`. Direct SQL then confirmed:

- sealed receipts reject late budget, usage, and artifact inserts;
- an unsealed parent fails at commit;
- fractional usage and values above `Number.MAX_SAFE_INTEGER` fail;
- token-bearing metadata/provenance, signed URL queries, and inline/base64
  references fail; and
- repository retry/get/list paths expose only sealed aggregates.

No new blocker or high-severity finding remained, and the verifier recommended
**ACCEPT** for the hardened checkpoint. Its Node live runner was sandbox-blocked
on both TCP and Unix sockets, so this independent receipt claims adversarial
`psql` proof rather than a second Node live suite; the primary zero-skip live
receipt above remains the Node integration evidence.

## Complete local regression — 2026-08-20

The complete M0–M8 local matrix passed. M1, M2, M5, M6, M7, and M8 used their
required live PostgreSQL paths. M0/M1 and M3 loopback fixtures used approved
local bind access. The first M3 attempt selected a host Python without
`setuptools`; rerunning the unchanged gate with the repository `.venv` first
on `PATH` passed the isolated wheel build and every remaining test. Foundation
validation passed through the documented `uv --with-requirements` command.

## Hosted receipt — 2026-08-20

GitHub Actions run
[32331835983](https://github.com/wesleykao1990/agent-feed/actions/runs/32331835983)
passed from a clean stacked pull-request checkout:

- combined `validate` job: M0–M3 and live PostgreSQL ingress green;
- Milestone 4 generic reference-consumer job green;
- Milestone 5 portability/operations job green;
- Milestone 6 remote MCP job green;
- Milestone 7 occurrence-ledger job green; and
- Milestone 8 job-proof job green with live PostgreSQL.

The pull request remains draft and unmerged by design. It is stacked on the
unmerged Milestone 7 branch, so PR #9 must land before PR #10 can be rebased or
retargeted to `main`.
