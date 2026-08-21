# submit_batch

The MCP `submit_batch` tool accepts the published `submit-batch.schema.json`
object, including its `run_id`. The producer service scopes the run before
full body processing, validates findings/evidence and security limits, then
atomically delegates the bounded idempotent write to persistence.

The published input schema keeps the nine required root properties directly
on the object and expresses “findings or evidence must be non-empty” with
`not` rather than a top-level union. This avoids connector generators
mistaking validation-only branches for alternate tool argument shapes.
