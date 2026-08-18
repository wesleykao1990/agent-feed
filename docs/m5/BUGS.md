# Milestone 5 bug and gap log

Started: 2026-08-18. This log is append-only.

| ID | Symptom / impact | Resolution and regression | Status |
|---|---|---|---|
| M5-001 | GitHub users had to assemble MCP dependencies, database variables, scoped credentials, and a protocol-clean command manually. | Added the root operator CLI, private generated runtime, Compose profile, doctor, and installation runbook. | Resolved locally |
| M5-002 | A naive private-file helper could chmod an arbitrary custom parent directory. | Confine setup config targets to the selected runtime tree and chmod only runtime-owned directories. | Resolved; path-boundary test |
| M5-003 | Forced writes could follow a symlink and overwrite a file outside the runtime. | Reject symlink config, database credential, and generated targets before any write. | Resolved; hostile symlink test |
| M5-004 | A direct `--database-url` places credentials in command history. | Add `--database-url-file` and require an owner-only regular file. | Resolved; file permission/conflict tests |
| M5-005 | Regenerating the bundled PostgreSQL password during `--force` would leave a persistent volume configured with the old password and make the new URL unusable. | Preserve existing database and producer credentials unless an explicit replacement is supplied. | Resolved; upgrade regression |
| M5-006 | The earlier ChatGPT runbook required manual environment exports and targeted the low-level launcher. | Make the generated credential-free wrapper the normal tunnel target and link to the GitHub installer. | Resolved in documentation |
| M5-007 | `doctor` checks socket reachability rather than authentication, migrations, or lifecycle semantics. | State the limit explicitly; retain MCP startup and live integrated gates as authoritative evidence. | Accepted boundary |
| M5-008 | Supabase/SQLite portability, retention/deletion, audit export, metrics, and dashboard work remain unimplemented. | Track them as later Milestone 5 slices; do not broaden M5A claims. | Open roadmap |
| M5-009 | Inheriting the complete parent environment would pass unrelated credentials, including the tunnel control-plane key, into the MCP child. | Build the child environment from a small OS/TLS/PostgreSQL-certificate allowlist plus exact Agent Feed variables. | Resolved; environment isolation test |
| M5-010 | Path containment alone does not reject a runtime directory or nested directory that is itself a symlink. | Reject symlink runtime/directory components before creating or writing generated state. | Resolved; linked-runtime regression |
| M5-011 | Setup initially accepted stream IDs outside the protocol schema and silently ignored unknown command flags. | Reuse the protocol `0.1` stream pattern and reject unknown/duplicate options per command. | Resolved; parser and invalid-stream regressions |
| M5-012 | An external PostgreSQL URL without a username depended on an ambient OS identity that the isolated MCP child correctly does not inherit. | Require the database principal explicitly in every configured URL. | Resolved; URL regression and live wrapper retest |
| M5-013 | The first sample-secret guard classified the documented long `replace-with-...` placeholder as a real credential. | Parse only secret-bearing variables, allow explicit placeholder words, and reject a real-looking adversarial value. | Resolved; architecture regression |
| M5-014 | The host's Python 3.14 lacked `setuptools`, so the M3 wheel smoke failed after all source/package tests passed. | Rerun the no-skip gate through `uv` with the repository's declared `requirements-dev.txt`; the isolated wheel install/import passed. | Resolved validation environment |
| M5-015 | CLI option mapping included absent values as `undefined`; spreading them over preserved upgrade state could reset a custom tenant, producer, stream, or PostgreSQL port during `--force`. | Merge only explicitly defined values over the existing configuration and exercise absent CLI-shaped fields in the force-upgrade regression. | Resolved |
