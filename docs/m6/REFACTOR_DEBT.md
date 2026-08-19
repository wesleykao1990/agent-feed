# Milestone 6 modularity and refactor-debt audit

Reviewed: 2026-08-18

| Module | Owns | Must not own |
|---|---|---|
| `apps/mcp-server` | Tool descriptors, official server factory, lifecycle router | HTTPS, OAuth, public hosting |
| `apps/mcp-http/src/auth.ts` | Token verification and pilot OAuth grants | Lifecycle validation or PostgreSQL |
| `apps/mcp-http/src/gateway.ts` | HTTP routing, discovery, edge validation, principal injection | Producer policy or duplicate tools |
| `apps/mcp-http/src/node-server.ts` | Bounded Node request/response adaptation | OAuth or MCP semantics |
| `apps/mcp-http/src/main.ts` | PostgreSQL/service/edge composition and process lifecycle | A second credential store |

No extraction is currently justified. The `AccessTokenVerifier` is already
the production replacement seam for a durable IdP. The pilot provider should
be replaced, not generalized into a home-grown production identity platform.
Likewise, TLS and tunnel processes stay outside this app rather than becoming
subprocess policy inside the gateway.
