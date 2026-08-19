# Milestone 7 acceptance record

Status: **accepted locally and independently; complete M0–M7 hosted matrix
green on draft PR #9**

Required evidence:

- occurrence-core clean install, build, and focused tests;
- persistence clean install, build, and complete live PostgreSQL suite;
- migration `0001` through `0004` applied twice;
- hostile provenance, grammar, key/window, stream, tenant, and direct-SQL tests;
- fixed interval and cron/DST materialization persisted and read back;
- misfire/overlap fixtures over persisted occurrences;
- concurrent one-run/one-occurrence enforcement;
- protocol `0.1` compatibility and checksum gates;
- complete M0–M6 regression; and
- clean-checkout GitHub Actions evidence.

Do not replace this pending statement with acceptance until every claimed
command and hosted run has actually passed without a live-database skip.

## Local receipt — 2026-08-20

Against fresh disposable database `agent_feed_m7_20260820_clean` on the local
PostgreSQL acceptance cluster:

- `npm run m7:architecture` passed 9 boundaries;
- occurrence-core build and 11/11 tests passed;
- persistence build and 14/14 tests passed with zero skips;
- migration `0001` through `0004` applied twice;
- hostile key/window/grammar/context/stream/direct-SQL and concurrency fixtures
  passed;
- persisted DST, misfire, and overlap fixtures passed; and
- protocol `0.1` compatibility and generated-type drift checks passed.

The exact combined command was `npm run m7:conformance` with
`AGENT_FEED_DATABASE_URL` set. An independent verifier reran the live gate,
confirmed that every prior blocker/high finding was resolved, and recommended
acceptance.

The complete M0–M6 local regression passed on 2026-08-20. M1, M2, M5, and M6
used their required live PostgreSQL paths with no acceptance skip. M3 passed
after its loopback HTTP test server was granted local bind access; the initial
`EPERM` was a sandbox restriction, not a product failure. M4 and all remaining
offline architecture, build, package, SDK, adapter, and protocol gates passed.

## Hosted receipt — 2026-08-20

GitHub Actions run
[32307120427](https://github.com/wesleykao1990/agent-feed/actions/runs/32307120427)
passed from a clean pull-request checkout after the local-dependency graph fix:

- combined `validate` job: M0–M3 and live PostgreSQL ingress green;
- Milestone 4 generic reference-consumer job green;
- Milestone 5 portability/operations job green;
- Milestone 6 remote MCP job green; and
- Milestone 7 occurrence-ledger job green with live PostgreSQL.

The pull request remains draft and unmerged by design.
