# Milestone 5 decision log

Started: 2026-08-18. This log is append-only.

| ID | Decision | Reason | Verification |
|---|---|---|---|
| M5-D001 | Deliver GitHub installability as Milestone 5A without declaring the broader operations roadmap complete. | Installation is independently useful; retention, audit, metrics, portability, and dashboard work need their own evidence. | Plan and acceptance documents enumerate remaining slices. |
| M5-D002 | Use one Node built-in-only operator module and a thin root CLI. | Setup needs no new dependency graph and remains unit-testable. | Operator tests and clean Node 22 CI. |
| M5-D003 | Generate secrets into owner-only ignored runtime files and keep the wrapper credential-free. | Commands, prompts, and process output must not disclose credentials. | Permission, wrapper-content, and architecture tests. |
| M5-D004 | Bind bundled PostgreSQL to localhost and preserve a named volume across CLI stop/upgrade. | The default is private and normal lifecycle operations must not delete data. | Compose guard and lifecycle argument tests. |
| M5-D005 | Reuse the existing stdio MCP server through a direct Node child process. | A second implementation or package-manager wrapper would duplicate policy or pollute JSON-RPC. | Exact environment and launcher architecture checks. |
| M5-D006 | Keep OpenAI tunnel/plugin/task creation explicit and outside the repository CLI. | These are account-security mutations with separate identity and approval boundaries. | CLI help/runbook guard prohibits tunnel credential ownership. |
| M5-D007 | Accept an owner-only regular file for an external database URL. | It avoids placing a credential in shell history and rejects weak filesystem handling. | Permission, symlink, conflict, and URL tests. |
| M5-D008 | Make `--force` preserve existing generated credentials by default. | Rotating a Docker password without updating the existing volume breaks access; silent identity rotation is also surprising. | Force-upgrade regression preserves URL/password/producer secret. |
| M5-D009 | Bound local credential and config file sizes before parsing. | Private local inputs can still be malformed; the operator does not need unbounded configuration documents. | Credential/config loader guards and operator regressions. |
