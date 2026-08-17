# API and MCP contract

## Idempotency

- `begin_run`: unique by authenticated producer + stream + idempotency key;
- `submit_batch`: unique by run + idempotency key; batch and finding IDs are immutable;
- `complete_run`: terminal and idempotent;
- delivery events: consumers deduplicate by event ID.

## Ordering

Batch sequence numbers must increase, but consumers must not rely on network arrival order. `run.completed` may be delayed until all accepted finding events are enqueued.

## Error classes

- schema validation;
- authorization/scope;
- conflict/idempotency mismatch;
- size/rate limit;
- run terminal;
- transient storage/delivery;
- security rejection.

## Signatures

Outbound webhooks include event ID, timestamp, protocol version, and signature. Consumers reject stale timestamps and record the event before returning success.
