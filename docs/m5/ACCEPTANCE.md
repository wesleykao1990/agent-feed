# Milestone 5A acceptance evidence

Status: **local M0–M5A integrated gates green; hosted pull-request evidence pending**

Revision: `agent/milestone-5-installability-operations`

Environment: macOS, Node 26.4.0 (minimum Node 22)

## Local M5A evidence

The required command is:

```sh
npm run m5:conformance
```

Expected coverage:

| Gate | Required result | Skips |
|---|---:|---:|
| Static installability boundary | Passed; 8 boundaries | 0 |
| Adversarial architecture tests | 6/6 passed | 0 |
| Operator behavior/security tests | 10/10 passed | 0 |
| Root CLI help smoke | Passed | n/a |
| Disposable setup and offline-doctor CLI smoke | Passed | n/a |

The dedicated GitHub Actions job starts from a clean checkout, installs the MCP
server's locked dependencies, and executes the same gate under Node 22. Hosted
evidence is not claimed until that pull-request job succeeds.

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

## Claims this gate does not make

M5A does not accept production hosting, Supabase, SQLite, retention/deletion,
audit export, observability exporters, a dashboard, or any OpenAI account-side
configuration. Existing live PostgreSQL and ChatGPT acceptance records remain
separate evidence.
