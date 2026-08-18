# M4 reference-consumer conformance matrix

The M4 test files are deliberately no-skip: a missing package, missing public
build, missing scope, or unsafe output is a failed acceptance result.

| ID | Acceptance proof | Test |
|---|---|---|
| M4-A01 | Public package export is importable and exposes only the reference observation surface | `conformance.test.mjs` public package import |
| M4-A02 | Finding maps to an explicitly untrusted observation; submitted evidence is retained and no reward/canonical/promotion output exists | `conformance.test.mjs` untrusted mapping |
| M4-A03 | `event_id` transport replay dedupe is distinct from semantic candidate dedupe; both lineages are retained | `conformance.test.mjs` transport vs semantic dedupe |
| M4-A04 | Exact retry permits an attempt change; payload drift under a reused event ID fails closed | `conformance.test.mjs` transport conflict |
| M4-A05 | Tenant, consumer, and stream scope prevent cross-scope collapse; unauthorized streams fail closed | `conformance.test.mjs` scope tests |
| M4-A06 | Changed generic claim content remains a distinct semantic proposition | `conformance.test.mjs` changed claim |
| M4-A07 | Hostile text and security flags remain untrusted, flagged content with no promotion surface | `conformance.test.mjs` hostile content |
| M4-A08 | Unknown attributes survive as untrusted data | `conformance.test.mjs` unknown attribute |
| M4-A09 | Lifecycle events do not synthesize source observations | `conformance.test.mjs` lifecycle input |
| M4-ARCH01 | Package manifest, build/test scripts, public entrypoint, and production implementation are required | `architecture.test.mjs` fail-closed repository/empty fixtures |
| M4-ARCH02 | Database/SQL, Agent Feed server, and private source-subpath dependencies are rejected | `architecture.test.mjs` leak fixture |
| M4-ARCH03 | Static implementation markers require protocol `0.1`, finding.submitted handling, untrusted observation, separate dedupe layers, evidence preservation, and tenant/consumer/stream scope | `check_m4_architecture.mjs` |

Expected totals: 10 behavioral tests and 6 architecture tests (16 M4 test
cases), with zero acceptance skips.
