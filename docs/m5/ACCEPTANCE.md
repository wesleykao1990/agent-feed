# Milestone 5A acceptance evidence

Status: **local M0–M5A integrated and hosted pull-request gates green**

Revision: `b6d4a821894b8ef2d4403e04df908d73e469a93d` on draft PR #6

Environment: macOS, Node 26.4.0 (minimum Node 22)

## Local M5A evidence

The M5A-only command is:

```sh
npm run m5a:conformance
```

The broader no-skip portability and operations command is
`npm run m5:conformance`; it requires an explicit PostgreSQL URL and is
recorded separately in `docs/16_milestone_5_portability_operations.md`.

On 2026-08-18 that combined command passed against a disposable PostgreSQL 16
database with no live-test skip: 14 SQLite tests plus demo, 12 Supabase static
boundaries, 13 operations-core tests, 9 observability tests, 8
operations-postgres unit tests plus 1 live acceptance test, 7 dashboard tests,
and the local PostgreSQL-compatible Supabase role/RLS/health/liveness/
immutability proof.

GitHub Actions run `32135239757` passed the complete validation job, Milestone
4 regression, and expanded full Milestone 5 job on draft PR #7 at commit
`817c28d37ec1512f9179d6b43f9484fb7d5b1b97`. Hosted Supabase deployment is
still outside this acceptance receipt.

Expected coverage:

| Gate | Required result | Skips |
|---|---:|---:|
| Static installability boundary | Passed; 8 boundaries | 0 |
| Adversarial architecture tests | 6/6 passed | 0 |
| Operator behavior/security tests | 10/10 passed | 0 |
| Root CLI help smoke | Passed | n/a |
| Disposable setup and offline-doctor CLI smoke | Passed | n/a |

GitHub Actions run `32128149827` passed the dedicated clean-checkout M5A job in
8 seconds, the M4 regression job in 13 seconds, and the complete live
PostgreSQL `validate` job in 1 minute 22 seconds. All ran against the revision
above with zero skipped acceptance tests.

The initial run warned about the old Node 20 runtime in GitHub's v4 actions.
After updating the official checkout/setup actions to v7, replacement run
`32128438231` passed M5A in 6 seconds, M4 in 8 seconds, and complete validation
in 1 minute 21 seconds without that annotation.

## Live operator smoke

A separate disposable PostgreSQL cluster on localhost was used; the existing
ChatGPT acceptance runtime was not read or modified. The external-database
installer wrote a private config and secret-free wrapper. `doctor` passed all
five checks, including the database socket. The generated wrapper then:

- started the existing production MCP composition root and applied migrations;
- wrote no package-manager or setup banner to stdout;
- negotiated legacy MCP `2025-06-18`; and
- returned exactly `begin_run`, `submit_batch`, and `complete_run` from
  `tools/list`.

The disposable server was stopped and its temporary directory removed after
the test.

## Integrated regression evidence

| Gate | Result |
|---|---:|
| Foundation validator | Passed; 9 schemas |
| Generated types and protocol compatibility | Passed; 3 artifacts |
| M0/M1 pure conformance | 23/23 passed |
| Prototype regression | 29/29 passed |
| Live PostgreSQL M1 ingress | 6/6 passed |
| Complete live PostgreSQL M2 gate | Passed; zero skips |
| Complete M3 gate | Passed inside declared Python requirements environment; zero skips |
| Complete M4 gate | Passed; architecture 6, behavior 10, package 9, build/pack green |

The source-only integrity inventory passes **362/362** files. Ignored runtime,
dependency, build, virtual-environment, and release outputs are excluded.

## Claims this M5A gate does not make

M5A does not accept production hosting, Supabase, SQLite, retention/deletion,
audit export, observability exporters, a dashboard, or any OpenAI account-side
configuration. The remaining M5 reference/contract slices now have their own
local evidence, but a local PostgreSQL-compatible Supabase proof is not hosted
production proof. Existing live PostgreSQL and ChatGPT acceptance records
remain separate evidence.
