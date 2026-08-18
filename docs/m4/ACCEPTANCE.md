# Milestone 4 acceptance evidence

Status: **local M0–M4 integrated and hosted gates green**

Revision: working tree on `agent/milestone-4-reference-consumer`

Environment: macOS, Node 26.4.0 (package minimum Node 22)

## Local evidence

Command:

```sh
npm run m4:conformance
```

| Gate | Result | Skips |
|---|---:|---:|
| Static architecture checker | Passed; 4 paths checked | 0 |
| Architecture tests | 6/6 passed | 0 |
| Public build behavioral tests | 10/10 passed | 0 |
| Focused package tests | 9/9 passed | 0 |
| Clean TypeScript build | Passed | n/a |
| `npm pack --dry-run` | Passed; 11 files | n/a |

The command uses a disposable npm cache for the pack smoke test, so it is
independent of user-global npm cache ownership.

The first hosted run (`32092456477`) caught a missing clean-build ordering
step: the local SDK was installed but its public `dist` export was absent. The
runner now validates and builds the SDK before compiling/importing the
reference. Replacement run `32092602939` passed.

## Remaining acceptance evidence

| Evidence | Status |
|---|---|
| Foundation/type/compatibility and M0 conformance | Passed; validator plus 23/23 tests |
| Live PostgreSQL M1 ingress | Passed; 6/6 tests, including evidence-bearing ChatGPT exact replay |
| Complete M2 gate with live PostgreSQL | Passed; all configured gates, zero skips |
| Complete M3 gate | Passed; architecture, behavioral, all packages, external npm/wheel smoke tests |
| GitHub Actions `validate` job | Passed in run `32092602939` (1m16s) |
| GitHub Actions Node-only `milestone-4-reference` job | Passed in run `32092602939` (9s) |

This ledger covers only the Agent Feed generic reference consumer. Production
durability, signed ingress, acknowledgement, and Rewards Optimizer domain
workflows must be proven in their owning repositories.
