# Agent Feed delivery worker

Status: **composition and integration boundary accepted; production process
deployment remains future operational work.**

This is the composition root for outbound delivery. It wires the existing
delivery-core state machine to the protocol runtime signer and the injected
webhook transport. It contains no SQL, `pg`, HTTP server, subscription/domain
logic, or secret-manager implementation.

`ProtocolDeliverySigner` maps the internal camelCase event to the exact
snake_case protocol-0.1 body. The body is canonicalized and signed as the
exact UTF-8 string sent by the transport. `attempt` is present in both the
signed body and `x-agent-feed-attempt`; retries therefore legitimately produce
a new raw body only because that envelope field changes. Event identity,
occurred time, payload, and the internal payload hash remain unchanged.

The signer verifies its own runtime output before returning it: the canonical
body must decode to the expected event ID and attempt, required runtime headers
must match the body/signature/key/timestamp, and optional trace headers must
match the derived W3C lineage. Replay generation remains core lease metadata;
it is not emitted as an undocumented protocol-0.1 header. Resolver and signing
failures are converted to stable messages so secret-manager URLs or diagnostics
cannot escape through delivery-core errors.

Key material is supplied through `DeliveryKeyResolver`; the worker never logs
or serializes secrets. Endpoint references are resolved by the webhook adapter
through its injected endpoint resolver. `createDeliveryWorker` accepts test
transports, repositories, clocks, metrics, signers, and retry policies. The
single-cycle function recovers expired leases before claiming work. The loop
uses an abort signal and has no process-global signal handlers, making shutdown
and deterministic tests explicit.

The signer keeps `payloadHash` as an immutable core-event property; protocol
0.1 intentionally has no `payload_hash` field in its strict wire body. It does
not mutate or recompute that source-event value. On retry, only the envelope
attempt changes, so the signed raw bytes and HMAC legitimately change while
the event ID, occurrence time, payload, and source payload hash remain stable.

The package has 6/6 tests, a clean install, and a clean TypeScript build. The
combined live PostgreSQL suite validates repository lease/retry/replay
behavior, while this package intentionally remains a composition root without
a CLI/process entrypoint or hosted webhook deployment.
