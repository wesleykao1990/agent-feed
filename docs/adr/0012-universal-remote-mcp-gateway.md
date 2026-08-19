# ADR 0012 — Universal remote MCP gateway

Status: Accepted and implemented locally

Date: 2026-08-18

## Context

The private ChatGPT integration transports the stdio MCP server through an
OpenAI tunnel. Claude custom connectors and other remote clients require a
public HTTPS Streamable HTTP resource with OAuth discovery. Copying the three
lifecycle handlers would create a second policy and schema implementation.

## Decision

Create a separate `apps/mcp-http` composition that imports
`createOfficialMcpServer`. Authenticate every MCP request at the HTTP edge,
place the resulting producer principal in official MCP request context, and
construct one server instance for that principal. Keep all lifecycle and
durability behavior in the existing producer service.

Support a static producer-token verifier and an interchangeable OAuth-token
verifier. Include a memory-only, single-operator authorization-code + PKCE
provider solely for bounded acceptance/pilot use. Production deployments must
replace it with a durable OAuth 2.1/OIDC provider.

## Consequences

Stdio and HTTP tool surfaces cannot drift because they share one factory.
Claude can connect through standard discovery and PKCE without learning the
long-lived producer secret. The pilot loses grants on restart by design and is
not highly available. Stable hosting, durable identity, operational TLS, and
provider-specific production receipts remain deployment work.

## Rejected alternatives

- An unauthenticated public MCP endpoint: violates tenant and producer trust.
- Producer credentials in tool arguments: lets model-generated data select
  authority and risks secret retention in transcripts.
- Claude-specific lifecycle handlers: duplicates policy and blocks reuse.
- Claiming the embedded provider as production OAuth: omits durability,
  federation, monitored rotation, and multi-instance revocation.
