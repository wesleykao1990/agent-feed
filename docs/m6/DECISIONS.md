# Milestone 6 decision log

Started: 2026-08-18. This log is append-only.

| ID | Decision | Reason | Verification |
|---|---|---|---|
| M6-D001 | Add `apps/mcp-http` as a separate transport composition and import the existing official MCP server factory. | Remote deployment concerns must not fork lifecycle schemas or policy. | Architecture guard and exact three-tool HTTP/stdin regressions. |
| M6-D002 | Convert validated Bearer credentials to a request-scoped `ProducerPrincipal`; never accept credentials as tool arguments. | Authentication belongs at the resource-server edge and application authorization remains centralized. | Missing/bad-token, principal-injection, and hostile-argument tests. |
| M6-D003 | Support static producer Bearer credentials and an optional embedded OAuth authorization-code + PKCE pilot behind one verifier interface. | Different MCP clients have different connection UX; the lifecycle boundary should not care how identity was established. | Composite-verifier and OAuth flow tests. |
| M6-D004 | Keep the embedded OAuth state memory-only and label it pilot-only. | It enables a bounded Claude acceptance test without pretending to solve durable identity, HA, or revocation. | Restart semantics documented; production claim prohibited by the architecture guard. |
| M6-D005 | Bind Node to loopback and require an explicit public `/mcp` URL plus Host allowlist. | TLS termination and public routing are deployment concerns; the process should not be exposed accidentally. | Default composition and Host rejection tests. |
| M6-D006 | Cap streamed bytes in the Node adapter before constructing a web `Request`. | `Content-Length` checks alone do not constrain chunked bodies. | Node transport body-limit regression. |
