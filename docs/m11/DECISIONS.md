# Milestone 11 decisions

| ID | Decision | Reason |
|---|---|---|
| M11-D001 | Add a pure comparison contract before persistence or provider automation. | All adapters and future projections need one fail-closed definition of comparability. |
| M11-D002 | Pin exact logical-job, policy, binding, and capability-profile identity. | Provider-name-only comparisons would mix revisions or deployment shapes. |
| M11-D003 | Require at least three distinct terminal topologies. | This is the approved roadmap threshold and prevents a single adapter retry from looking multi-provider. |
| M11-D004 | Reuse M8 telemetry states and M9 ingress kinds. | New provider-specific vocabularies would fragment established proof semantics. |
| M11-D005 | Hash external invocation identity and reject free metadata. | Comparability does not require account identifiers, URLs, credentials, prompts, or outputs. |
| M11-D006 | Treat the first five fixtures as synthetic adapter evidence only. | Injected lifecycle services do not prove scheduling, authorization, durability, or hosting. |
