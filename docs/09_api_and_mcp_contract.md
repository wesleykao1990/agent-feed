# API and MCP contract

## Idempotency

- `begin_run`: unique by authenticated producer + stream + idempotency key;
- `submit_batch`: unique by run + idempotency key; batch and finding IDs are immutable;
- `complete_run`: terminal and idempotent;
- delivery events: consumers deduplicate by event ID.

## Ordering

Batch sequence numbers must increase, but consumers must not rely on network arrival order. `run.completed` may be delayed until all accepted finding events are enqueued.

Pull pages use an opaque cursor over a tenant-global monotonically increasing
delivery position. The historical schema may call that field
`stream_position`, but it must not reset per stream: a selector spanning
multiple streams needs one total order. A stable event-ID tie-breaker may be
used for equal timestamps/compatibility ordering. A cursor is bound to the
tenant, authenticated consumer, subscription, and filter/version context that
issued it; it must not be transferred between consumers or subscriptions. A
cursor is not an acknowledgement and does not change delivery state.

## Error classes

- schema validation;
- authorization/scope;
- conflict/idempotency mismatch;
- size/rate limit;
- run terminal;
- transient storage/delivery;
- security rejection.

## Signatures

Outbound webhooks include event ID, delivery ID, timestamp, protocol version,
attempt, key ID, trace/correlation metadata, and signature metadata. The
protocol-runtime package signs the exact canonical snake_case wire body with
the pinned HMAC-SHA256 `timestamp.body` input and five-minute replay window.
The required `attempt` is in the signed protocol body. A retry or replay
therefore re-encodes and re-signs the body with its new attempt, while
`event_id`, payload, `occurred_at`, and payload hash remain the immutable source
identity. Consumers reject stale timestamps and record the event before
returning success. The M2 consumer service, live PostgreSQL repository, webhook
adapter, and worker composition pass the implementation gate; the
transport-neutral `apps/delivery-api` remains without a deployable HTTP server
and the worker remains without a production process/CLI entrypoint. The
generated finding
events precede one terminal event (`run.completed`, `run.partial`, or
`run.failed`); cancellation remains represented by the terminal payload while
the v0.1 event enum has no separate `run.cancelled` value.
