# complete_run

The MCP `complete_run` tool accepts the published `complete-run.schema.json`
object, including its `run_id`, and delegates terminal status, actual scope,
statistics, errors, idempotency, and immutable completion policy to the
producer service. Durable persistence emits the corresponding outbox event.
