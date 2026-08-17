# MCP server

Status: **contract/reference only; no executable MCP server is present in this
directory.**

The intended initial write-only surface contains exactly three tools:

- `begin_run`
- `submit_batch`
- `complete_run`

When implemented, the server must validate protocol schemas, authenticate the
producer, enforce stream scope, apply idempotency, and delegate to the same
application service used by REST. MCP is an adapter, not a separate storage
implementation. Durable M2 consumer delivery is not an MCP capability in this
directory; see `docs/operations/delivery-api.md` for its separate status.
