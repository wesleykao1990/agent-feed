# begin_run

The MCP `begin_run` tool accepts the published `begin-run.schema.json` object
and returns the durable `RunRecord` as JSON text plus structured MCP content.
The producer service authenticates the producer, enforces its allowed stream,
validates the protocol, and applies begin idempotency before persistence.
