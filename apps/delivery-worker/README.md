# Agent Feed delivery worker

Status: **durable worker composition and a bounded production-shaped process
entrypoint are implemented; deployment hosting remains operational work.**

This is the composition root and process entrypoint for outbound delivery. It
wires the existing delivery-core state machine to the PostgreSQL delivery
repository, protocol runtime signer, and injected webhook transport. The
worker still contains no SQL or alternate delivery state machine: PostgreSQL
claims/leases and the delivery-core worker remain the durable source of truth.

Run one bounded recovery-and-claim cycle from the repository root with:

```sh
npm --prefix apps/delivery-worker start -- --once \
  --database-url-file .runtime/agent-feed/database-url \
  --tenant-id rewards-local \
  --consumer-id rewards-optimizer \
  --signing-keys-file .runtime/agent-feed/delivery-keys.json
```

Omit `--once` for the abortable polling loop. The equivalent environment
variables are documented by `npm --prefix apps/delivery-worker start -- --help`.
The command prints only bounded counters and stable error codes; it never
prints database URLs, endpoint URLs, event payloads, or signing key material.

Historical events remain future-subscription-invisible unless an operator
explicitly materializes one exact set. The bounded command requires repeated
event IDs plus repeated run IDs as a cross-check; it has no all-history, date,
position, or stream wildcard:

```sh
npm --prefix apps/delivery-worker run materialize-history -- \
  --tenant-id rewards-local \
  --consumer-id rewards-optimizer \
  --subscription-id 00000000-0000-4000-8000-000000000001 \
  --event-id event-one --event-id event-two \
  --run-id run-one
```

The existing active subscription selectors are reapplied to every requested
event. Missing IDs, an event/run-set mismatch, quarantined events, selector
mismatches, duplicate input IDs, or an unavailable subscription reject the
entire transaction. Repeating the same command returns the same target count
with those rows reported as already materialized. This command creates only
delivery queue rows; it cannot alter outbox events, receipts,
acknowledgements, findings, or evidence.

The key file is an owner-only JSON map keyed by the subscription's
`signing_secret_ref`:

```json
{
  "rewards-optimizer-key-2026": {
    "secret": "stored-outside-source-control"
  }
}
```

The loader rejects symlinks, group/other-readable files, malformed entries,
and unsafe key references. A deployment can replace the file resolver with a
secret-manager-backed `DeliveryKeyResolver`; the worker contract is the same.

The subscription owns stream and event-type selection. This means terminal
protocol events (`run.completed`, `run.partial`, and `run.failed`) are
delivered for a rewards stream when that durable subscription selects them;
Agent Feed does not contain rewards-specific source or rule logic.

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

The package tests the signer, retry bridge, loop, key-reference resolver, CLI
argument/config boundary, and summary output. The combined live PostgreSQL
suite validates repository lease/retry/replay behavior. A local one-shot run
is bounded and replay-safe: the worker recovers expired leases, claims due
rows with `SKIP LOCKED`, sends the signed event, and acknowledges by the
existing `(subscription_id,event_id)` durable identity. External endpoint
hosting and secret-manager deployment remain operational work.
