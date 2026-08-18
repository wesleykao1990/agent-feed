# submit_batch

The MCP `submit_batch` tool accepts the published `submit-batch.schema.json`
object, including its `run_id`. The producer service scopes the run before
full body processing, validates findings/evidence and security limits, then
atomically delegates the bounded idempotent write to persistence.
