# Interruption-safe bounded Agent Feed runs

`submit_bounded_run` is the preferred MCP action for normal bounded producer work when a caller may be interrupted between tool calls.

It accepts `begin`, zero or more `batches`, and `complete`. Batch and completion payloads omit `run_id`; the server injects the canonical ID returned by `begin_run`.

The adapter still routes every component through the existing ProducerService. This is a replay-safe composite operation rather than one database transaction: if execution is interrupted, retry the same request with unchanged component idempotency keys.
