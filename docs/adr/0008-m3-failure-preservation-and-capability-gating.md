# ADR-0008: Preserve adapter failures and gate automated export by capability

Status: Accepted and implemented; hosted CI green
Date: 2026-08-18

## Context

An agent may lose tool or network access after beginning a run or after one or
more accepted batches. Silent adapter failure would leave a run looking active
indefinitely and discard the producer's actual scope and error information.
ChatGPT Scheduled Tasks also cannot be assumed to have an Agent Feed webhook
or arbitrary tool access in every environment.

## Decision

Adapters use an explicit failure-preservation policy:

1. Before a run exists, validate without side effects and return a stable,
   redacted error.
2. After a run exists, attempt an idempotent terminal `partial` or `failed`
   completion containing actual scope and a non-secret error code.
3. If terminal completion itself cannot reach Agent Feed, persist or return a
   resumable run bundle/recovery record; never report success and never discard
   it silently.

Recovery artifacts intentionally contain the original protocol material needed
for exact replay. Public error messages and diagnostics are redacted;
protecting the recovery store itself is an explicit deployment responsibility.
Recovery-bearing error properties are non-enumerable and define safe JSON
serialization so ordinary telemetry cannot copy the bundle accidentally.

Signed webhook ingestion additionally requires a stable upstream event ID.
The adapter prevents process-local replay and exposes an atomic replay-store
port for deployments that require the claim to survive restarts. Generated
manual-export identities cover task/stream context and occurrence time; an
exact retry reuses the original exported bundle rather than regenerating it.

Scheduled Task export is capability-gated. Instructions may use direct
ingestion only when the runtime exposes an explicit approved Agent Feed tool or
endpoint credential. Otherwise the output is a protocol-valid run bundle for
manual/local-file import. Documentation must not claim a Scheduled Task webhook
capability that the runtime does not expose.

## Consequences

- Partial work remains distinguishable from a zero-finding completed run.
- Exact retry can recover without duplicating accepted lifecycle operations.
- Tool-less agents remain first-class producers through run bundles.
- Automation claims stay aligned with actual runtime capabilities.

## Evidence required

- Failure injection after begin and after a batch proves terminal closure or a
  returned/persisted recovery artifact.
- Recovery replay is idempotent.
- Capability-present and capability-absent export fixtures both pass.
- Public errors and recovery metadata are checked for credential and evidence
  leakage.
