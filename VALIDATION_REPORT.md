# Agent Feed Foundation v0.1.1 validation report

Validated: **2026-08-18**

## Result

**Milestone 3 implementation and hosted pull-request CI gates passed. Agent
Feed's immutable `schema-v0.1.1` release is published.**

Milestone 3 GitHub Actions run `32089066103` passed on reviewed source commit
`52594aa` in draft PR #4. The pull request remains intentionally unmerged.

Hosted pull-request CI also passed on source commit
`b217470552d668d6694edfa7e28b15b3279a73f5` in run `32056120146`, including
clean installs/builds, the schema candidate and external consumer, live
PostgreSQL ingress, and the full Milestone 2 regression gate.

The executable producer surface is now `apps/api`, composed through
`@agent-feed/producer-service` and backed by
`PostgresAgentFeedPersistence`. It accepts canonical protocol `0.1` requests,
does not import the prototype, contains no handler SQL, and preserves data and
idempotency receipts across an API restart. The local-file adapter uses the
same application service and durable store.

Current green evidence:

- protocol generated-type drift and compatibility checks;
- foundation package validator;
- Milestone 0/1 conformance: **23/23**;
- in-memory prototype regression: **29/29** (supporting evidence only);
- publishable schema package: **4/4**;
- producer application service: **9/9**;
- producer API: **2/2**;
- durable local-file adapter: **6/6**;
- live PostgreSQL producer ingress: **5/5**, including API restart;
- direct PostgreSQL persistence: **11/11**;
- full M2 conformance: architecture 4, pure 6, live PostgreSQL 3,
  protocol-runtime 5, delivery-core 18, delivery-consumer 10, persistence 11,
  webhook 8, worker 6, and delivery API 5;
- Milestone 2 repository source-integrity inventory: **237/237**, from its
  accepted clean-equivalent checkout (ignored build/release outputs excluded).

The live producer gate rejects a missing database URL rather than converting it
to a skip. It covers tenant/producer/stream authorization, exact retries and
payload drift, atomic evidence/outbox writes, terminal immutability,
completed-zero queryability, size/cardinality/Unicode/metadata boundaries,
secret and hostile evidence handling, quarantine eligibility, and rate-limit
responses.

An independent adversarial re-audit cleared the checksum, real process-restart,
exact producer scope, migration-ledger, media-type/draining, and static-boundary
issues. The first hosted PR run then found a source-linked concrete adapter
dependency that a populated local checkout had masked. The producer service now
owns an adapter-neutral persistence port and its architecture gate rejects that
dependency class. The next hosted run cleared that stage and exposed a synthetic
pull-request ref being mistaken for a schema tag; ref-type regression tests now
separate PR candidates from tag releases. Agent Feed's publication dependency
has since been completed. The downstream Rewards pin is owned by its separate
repository and is not part of M3.

## Published schema release

`@agent-feed/schema@0.1.1` is independently buildable and publishable while its
wire protocol remains `0.1`. The immutable published artifact is:

- artifact: `agent-feed-schema-0.1.1.tgz`;
- URL: `https://github.com/wesleykao1990/agent-feed/releases/download/schema-v0.1.1/agent-feed-schema-0.1.1.tgz`;
- tag source commit: `ad7e1a7270d0ebc09ffdc844d38cfa71a87bf95e`;
- size: 13,078 bytes;
- SHA-256: `9e020aba4e291f2e5328897dfb07195aaf392f6ecdd742b5c13b890cffdd9d6e`;
- SHA-512 integrity: `sha512-KHALcE3zQ/dey5GTXepDeXaz77Qf1DP3ySA+rcbG6eiFvUTws21cry8rfM191wyLeQthJ9ENd0neu23ETwX5/g==`.

The `schema-v*` release workflow validated tag/package-version equality,
rebuilt and verified the artifact from tagged source, and published it without
replacement.
See `docs/m1-hardening/ACCEPTANCE.md`.

## Milestone 3 evidence

The integrated no-skip M3 gate passed locally: architecture 4,
cross-boundary conformance 12, producer service 9, API 2, MCP 10, TypeScript
SDK 5 including packed external import, Python SDK 10 plus an isolated
wheel/install/import, REST 4, local-file 10, generic webhook 7, Claude hook 5,
and ChatGPT manual export 6. Full foundation,
protocol, prototype, live M1, and live M2 regressions also pass. Hosted run
`32089066103` reproduced the clean-checkout workflow on source commit
`52594aa`.
The Milestone 3 candidate source-integrity inventory passes **318/318** files;
ignored dependency, build, and release outputs are excluded.
See `docs/m3/ACCEPTANCE.md`.
