# Milestone 11 refactor debt

- Add an append-only PostgreSQL projection only after the pure receipt is
  independently reviewed; do not put provider fields into M7–M9 tables.
- Replace injected lifecycle fixtures with additional live acceptance harnesses
  without removing the fast deterministic contract gate.
- Extract shared test bundle builders only if another milestone needs them;
  production code currently has no duplicated provider policy.
- Preserve the exact M8 telemetry and M9 ingress imports rather than creating a
  second vocabulary during persistence work.
