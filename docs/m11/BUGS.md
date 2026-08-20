# Milestone 11 bugs

| ID | Finding | Resolution |
|---|---|---|
| M11-001 | A readonly public telemetry coverage type was used as a mutable matrix accumulator. | Use a private mutable accumulator and return the readonly shape. |
| M11-002 | TypeScript 7 checked transitive generated schema declarations whose NodeNext JSON imports predate import attributes. | Follow the existing MCP package precedent with `skipLibCheck`; strict checking remains enabled for M11 source and tests. |
| M11-003 | The first offline fixture submitted an empty protocol batch and an unsupported producer type. | Use the existing `automation` producer type and one non-sensitive evidence item with reconciled completion counts. |
| M11-004 | The host system Python did not expose the repository's declared `jsonschema` dependency. | Run the unchanged validator through `uv` with `requirements-dev.txt`; the foundation gate passed without waiving validation. |
| M11-005 | Delimiter-joined topology identities could collide when provider keys themselves contained the delimiter. | Compare canonical serialized typed tuples and cover the adversarial case. |
| M11-006 | Freezing only the receipt root left nested proof and telemetry values mutable at runtime. | Freeze nested objects, arrays, observations, and matrix coverage entries. |
| M11-007 | The first Node live-regression attempt was blocked by the workspace sandbox with `connect EPERM`, although direct `psql` reached the same local database. | Rerun the unchanged M7–M10 gates through the approved local-network boundary; every live PostgreSQL test passed with no skips. |
| M11-008 | The first hosted M11 job installed the schema package but did not build its generated `dist` artifact, so transitive adapter type resolution failed on a clean checkout. | Make the M11 runner build the exact schema dependency before compiling the provider-conformance package and protect the step with the architecture guard. |
