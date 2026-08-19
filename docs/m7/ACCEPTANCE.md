# Milestone 7 acceptance record

Status: **local implementation/live PostgreSQL evidence, independent
re-review, and complete M0–M6 local regression green; hosted evidence pending**

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

Checksum refresh and clean-checkout hosted CI remain required before final
acceptance.
