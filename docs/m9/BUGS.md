# Milestone 9 bugs

| ID | Finding | Resolution |
|---|---|---|
| M9-001 | The first local PostgreSQL start was blocked by detached shared-memory segments from stopped test clusters. | Removed three verified zero-attachment 56-byte test segments; no running segment or database files were touched. |
| M9-002 | The first hostile no-shadow fixture changed a projected version without updating its canonical document, so projection validation rejected it before the intended guard. | Build the hostile row from a valid shadow binding and change the canonical activation projection consistently; also strengthen exact profile, evidence, and preflight pin checks. |
| M9-003 | The first M3 regression run could not bind its localhost API test listener inside the filesystem/network sandbox (`EPERM`). | Reran the unchanged gate with approved loopback access and the repository `.venv`; every M3 check, including the external Python wheel import, passed. |
| M9-004 | Final direct-SQL review found that an active definition could present a non-empty but malformed budget array unless PostgreSQL repeated the core element grammar. | Added database structure and uniqueness checks for budgets, required capabilities, output contracts, capability offerings, schema versions, policy/reference projections, and a hostile malformed-budget fixture. |
