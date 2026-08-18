# Milestone 3 acceptance evidence

Validated: 2026-08-18
Status: **implementation and hosted pull-request CI gates green**

## Integrated result

Milestone 3 is implemented on `agent/milestone-3-mcp-sdks-adapters` from the
merged Agent Feed baseline `ad7e1a7`. It does not include or modify Rewards
Optimizer code.

The public MCP executable, REST API, and producer adapters delegate to the
same `@agent-feed/producer-service` boundary. SDKs and adapters do not import
PostgreSQL or server internals. The consumer SDK surface remains
transport-injected and does not claim a deployed consumer HTTP service.

## Milestone 3 no-skip gate

Run from the repository root:

```sh
PATH=/tmp/agent-feed-m3-venv/bin:$PATH npm run m3:conformance
```

The path override supplies the declared Python build backend for the isolated
wheel check. Create that environment with `python3 -m venv` and install
`requirements-dev.txt`, or use an equivalent activated development environment.

| Suite | Result |
|---|---:|
| Architecture | 4/4 |
| Cross-boundary behavioral conformance | 12/12 |
| Producer service | 9/9 |
| Producer API composition wrapper | 2/2 |
| MCP server | 10/10 |
| TypeScript SDK | 5/5, including packed external import |
| REST adapter | 4/4 |
| Local-file adapter | 10/10 |
| Generic webhook adapter | 7/7 |
| Claude hook adapter | 5/5 |
| ChatGPT manual-export adapter | 6/6 |
| Python SDK | 10/10 |
| Python isolated wheel build, install, and external import | Passed |
| Repository source-integrity inventory | 340/340 |
| Acceptance skips | 0 |

## Full regression gate

The integration pass also ran:

```sh
python3 scripts/validate_package.py
npm run types:check
npm run protocol:compatibility
npm run conformance:test
npm run prototype:test
AGENT_FEED_DATABASE_URL=postgresql://agent_feed_test@127.0.0.1:55435/agent_feed_test npm run m1:ingress
AGENT_FEED_DATABASE_URL=postgresql://agent_feed_test@127.0.0.1:55435/agent_feed_test npm run m2:conformance
npm run checksums:check
```

The disposable PostgreSQL suites ran live; no acceptance skip flag was used.
The foundation validator passed all nine schemas, examples, generated-type
drift, semantic invariants, and trust checks. M0/M1 conformance passed 23/23,
the prototype passed 29/29, live M1 ingress passed 6/6, and the full M2 gate
passed architecture 4, pure 6, PostgreSQL 3, protocol-runtime 5, delivery-core
18, delivery-consumer 10, persistence 11, webhook 8, worker 6, and API 5.

## Release decision

Rows M3-A01 through M3-A14 are accepted. GitHub Actions run `32089066103`
passed the complete clean-checkout workflow on reviewed source commit
`52594aa` in PR #4, which was subsequently merged.
