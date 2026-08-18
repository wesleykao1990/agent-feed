# Agent Feed Foundation v0.1.1 validation report

Validated: **2026-08-18**

## Result

**Milestone 5A GitHub installability local, integrated, and hosted gates passed
on draft PR #6. Milestones 0–4 remain green and Agent Feed's immutable
`schema-v0.1.1` release is published.**

Milestone 3 GitHub Actions run `32089258429` passed on PR #4, which is merged
to `main` as `60315f85224a0751b0e86a3a8dcfb309e582cba3`.

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
- live PostgreSQL producer ingress: **6/6**, including API restart and durable
  ChatGPT exact replay;
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
cross-boundary conformance 12, producer service 9, API 2, MCP 11, TypeScript
SDK 5 including packed external import, Python SDK 10 plus an isolated
wheel/install/import, REST 4, local-file 10, generic webhook 7, Claude hook 5,
and ChatGPT manual export 6. Full foundation,
protocol, prototype, live M1, and live M2 regressions also pass. Hosted run
`32089066103` reproduced the clean-checkout workflow on source commit
`52594aa`.
The Milestone 3 candidate source-integrity inventory passes **318/318** files;
ignored dependency, build, and release outputs are excluded.
See `docs/m3/ACCEPTANCE.md`.

## Milestone 4 evidence

The Agent Feed–owned deliverable is the runnable generic reference package in
`examples/rewards-optimizer/`; it is not the separate Rewards Optimizer app.
The no-skip `npm run m4:conformance` gate passed locally:

- static architecture checker: passed, 4 paths checked;
- architecture tests: **6/6**;
- public built-artifact behavioral tests: **10/10**;
- focused TypeScript package tests: **9/9**;
- clean ESM/declaration build and public import: passed; and
- `npm pack --dry-run`: passed with 11 intended files using a disposable cache.

The same candidate also passed the foundation validator, generated-type and
protocol compatibility checks, M0/M1 conformance **23/23**, live PostgreSQL M1
ingress **6/6**, the complete live PostgreSQL M2 gate, and the complete M3 gate
including external TypeScript package and Python wheel install/import smoke
tests. Hosted M4 CI passed in GitHub Actions run `32096064685`, and PR #5 is
merged to `main` as `16e84f0eb545a55b5035bc11212ef46043a3aa30`.
See `docs/14_milestone_4_reference_consumer.md` and `docs/m4/ACCEPTANCE.md`.

The candidate source-integrity inventory passes **339/339** files; ignored
dependency/build/package outputs are excluded. GitHub Actions run
`32092602939` passed the dedicated M4 job and the complete `validate` job on
source commit `1f594d868648c8533dc4040236ea2af20ac6db76`.

## Milestone 5A evidence

The local no-skip `npm run m5:conformance` gate passed with:

- static installability guard: 8 boundaries;
- adversarial architecture tests: **6/6**;
- operator/security tests: **10/10**;
- root help, disposable setup, and offline-doctor CLI smokes: passed; and
- clean locked MCP dependency installation: passed.

A disposable live PostgreSQL test also proved the generated private runtime and
credential-free wrapper. `doctor` passed all five checks. The wrapper emitted
no banner, negotiated MCP `2025-06-18`, and listed exactly `begin_run`,
`submit_batch`, and `complete_run`; the temporary cluster was then stopped and
removed. The existing ChatGPT acceptance runtime was not modified.

Integrated regressions passed: foundation validation, generated types and
protocol compatibility, M0/M1 conformance **23/23**, prototype **29/29**, live
M1 ingress **6/6**, complete live M2, complete M3 inside the declared Python
requirements environment, and complete M4. GitHub Actions run `32128149827`
passed the dedicated M5A, M4 regression, and complete live PostgreSQL validation
jobs at source revision `b6d4a821894b8ef2d4403e04df908d73e469a93d`. See `docs/15_milestone_5a_installability.md`
and `docs/m5/ACCEPTANCE.md`. The source-only integrity inventory passes
**362/362** files; ignored runtime, dependency, build, virtual-environment, and
release outputs are excluded.
