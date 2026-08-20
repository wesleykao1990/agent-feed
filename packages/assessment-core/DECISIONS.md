# Assessment-core decisions

| ID | Decision | Reason |
| --- | --- | --- |
| M8-AC-D001 | Keep validation policies, submissions, and policy checks in a provider-neutral pure package. | Provider adapters differ in identity, telemetry, and storage, while the evidence contract must remain comparable. |
| M8-AC-D002 | Keep assessor authority out of assessment input and resolve it as a separate trusted argument. | A producer must not be able to self-assert independent-agent, human-reviewer, or validation-service authority. |
| M8-AC-D003 | Normalize telemetry states explicitly and require a value plus non-unknown provenance only for `observed`. | Missing telemetry must remain unknown or not-applicable; it must never be interpreted as zero. |
| M8-AC-D004 | Hash only the normalized request payload; server-assigned IDs, timestamps, technical run status, and idempotency keys are outside the request hash. | Reassessment is append-only and idempotency must not make equivalent evidence hash differently. |
| M8-AC-D005 | Store artifact identity as a lower-case SHA-256 plus bounded opaque reference metadata, never inline bytes or signed URLs. | Agent Feed records provenance and identity while leaving blob retention to an external artifact system. |
| M8-AC-D006 | Reject unknown fields and credential-shaped metadata recursively. | TypeScript structural typing is not a runtime trust boundary; extra authority or secret-bearing fields must fail closed. |
