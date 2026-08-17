# MCP server

The initial write-only MCP surface contains exactly three tools:

- `begin_run`
- `submit_batch`
- `complete_run`

The server validates protocol schemas, authenticates the producer, enforces stream scope, applies idempotency, and delegates to the same application service used by REST. MCP is an adapter, not a separate storage implementation.
