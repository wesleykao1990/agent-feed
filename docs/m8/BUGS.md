# Milestone 8 bug and gap log

Started: 2026-08-20. This log is append-only.

| ID | Symptom / impact | Resolution and regression | Status |
|---|---|---|---|
| M8-001 | The first delegated persistence type draft used assessor, assessment, failure, and provenance values that differed from the frozen core contract. | Remove the duplicate stale block and use one exact vocabulary shared with `assessment-core`; enforce it in architecture and build gates. | Resolved in integration. |
| M8-002 | The first artifact repository insert omitted the required `artifact_kind` column, so any assessment with an artifact would fail. | Insert the normalized kind and retain a live artifact round-trip fixture. | Resolved; live regression green. |
| M8-003 | The first database policy trigger hashed PostgreSQL `jsonb::text`, whose bytes do not equal the core canonical JSON bytes. | Persist the exact canonical JSON string and verify its SHA-256 in PostgreSQL; test policy creation against the live migration. | Resolved; live regression green. |
| M8-004 | Independent direct-SQL review could append usage and artifact children after the parent assessment committed, changing the effective receipt despite append-only update/delete triggers. | Add an atomic immutable seal, require it by commit, hide unsealed parents, and reject child inserts after sealing. | Resolved; independent hostile re-review accepted. |
| M8-005 | Database numeric checks accepted fractional observed usage, bypassing the core safe-integer contract. | Enforce integer and JavaScript-safe upper bounds in SQL and repository normalization. | Resolved locally; hostile live regression green. |
| M8-006 | Database artifact metadata/provenance accepted sensitive keys and recognizable credential-shaped values. | Add database-side safety guards matching the core boundary and hostile direct-SQL fixtures. | Resolved locally; hostile live regression green. |
| M8-007 | The first foundation validation used the host interpreter, which did not have `jsonschema`, although the repository declares it. | Rerun through the documented `uv --with-requirements` command and keep environment failure distinct from product failure. | Resolved; managed foundation gate green. |
| M8-008 | The first full M3 regression selected Homebrew Python 3.14 without `setuptools`, so the isolated wheel build failed after all behavioral tests passed. | Put the repository `.venv` first on `PATH` and rerun the unchanged gate with its declared build dependency. | Resolved; complete M3 gate green. |
