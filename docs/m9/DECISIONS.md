# Milestone 9 decisions

| ID | Decision | Reason |
|---|---|---|
| M9-D001 | Separate logical definitions, capability profiles, and deployment bindings into immutable version streams. | Provider moves must preserve logical job history. |
| M9-D002 | Treat recorded `active` state as proof, not external activation authority. | Agent Feed is scheduler-neutral and must not become a provider control plane. |
| M9-D003 | Require exact policy/profile/assessment version pins. | Mutable “latest” references make historical preflight unverifiable. |
| M9-D004 | Store instruction digests or controlled references only. | Registry rows must contain no prompts, inline artifacts, credentials, or signed URLs. |
