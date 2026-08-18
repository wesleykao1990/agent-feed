# Milestone 4 bug and gap log

Started: 2026-08-18. This log is append-only.

| ID | Symptom / impact | Resolution and regression | Status |
|---|---|---|---|
| M4-001 | The original fixtures demonstrated protocol shape but provided no runnable consumer. | Added the buildable generic package, focused tests, public-artifact conformance, and architecture gate. | Resolved |
| M4-002 | An initial documentation pass treated M4 as acceptance of the external Rewards Optimizer, contradicting the Agent Feed roadmap and task scope. | Reframed all M4 evidence around the local generic reference integration; external durability and domain workflows are explicitly out of scope. | Resolved |
| M4-003 | A repeated `event_id` was accepted as a duplicate even when immutable payload content changed. This could hide producer corruption or collision. | Store a canonical immutable-event fingerprint per scoped receipt; allow `attempt` changes but reject payload drift with `transport_payload_conflict`. | Resolved |
| M4-004 | The architecture checker resolved only the declared `dist` export, so a clean checkout could fail before the build existed. | Fall back to production source for static analysis; the integrated gate separately builds and imports the declared public artifact. | Resolved |
| M4-005 | The README construction example omitted the required stream allowlist. | Updated the example and added stream-denial coverage. | Resolved |
| M4-006 | The first pack smoke test inherited a root-owned user npm cache and failed despite all code tests passing. | The runner now creates and removes a task-local disposable npm cache. | Resolved |
| M4-007 | Early hostile-input coverage asserted instruction-like text but not explicit security flags or evidence handling restrictions. | Added flags/restriction data and preservation assertions; public conformance also uses the hostile run fixture. | Resolved |
| M4-008 | Production receipt durability, signed ingress, ACK/retry/dead-letter behavior, and domain review are not implemented here. | Keep them out of this reference package and require their owning deployments/apps to prove them separately. | Accepted boundary |
| M4-009 | The first hosted Node-only job installed the local SDK but did not build its declared `dist` export before compiling the reference. A populated local checkout masked the ordering dependency. | The fail-closed M4 runner now validates and builds the public SDK dependency before the reference build and public-artifact tests. | Resolved; hosted run `32092602939` passed |
