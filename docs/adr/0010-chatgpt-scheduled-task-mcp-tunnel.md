# ADR-0010: Reuse the stdio MCP server for ChatGPT Scheduled Tasks through Secure MCP Tunnel

Status: Accepted
Date: 2026-08-18

## Context

The Milestone 3 capability gate correctly required actual callable tools, but
its surrounding documentation reflected an earlier product state and treated
ordinary web Scheduled Tasks as tool-less by default. Current ChatGPT web
Scheduled Tasks can use installed plugins and connected MCP tools. OpenAI
Secure MCP Tunnel can connect a private stdio or HTTP MCP server without a
public inbound listener.

Agent Feed already has an authenticated, PostgreSQL-backed stdio MCP server
that exposes exactly `begin_run`, `submit_batch`, and `complete_run` through the
shared producer service. Adding a ChatGPT-specific HTTP implementation or a
fourth convenience tool would duplicate policy or weaken the stable surface.

## Decision

- Use an installed ChatGPT developer plugin as the explicit Scheduled Task
  capability.
- Use Secure MCP Tunnel for private development and acceptance testing, with
  the protocol-clean `apps/mcp-server/bin/agent-feed-mcp-stdio` launcher as its
  stdio command. Package-manager wrappers are forbidden on this wire because
  their stdout banners are not JSON-RPC.
- Associate the tunnel with both its Platform organization and the exact
  ChatGPT workspace that owns the plugin and scheduled task.
- Keep database, producer, and tunnel credentials in the local process
  environment; never place them in the task prompt or MCP inputs.
- Require all three lifecycle tools and actual receipts before the task may
  claim delivery.
- Retain the validated run-bundle/local-file path whenever the installed plugin
  or any lifecycle operation is unavailable.
- Treat a public HTTPS streamable-HTTP plugin endpoint and user-facing OAuth as
  a separate production-deployment decision, not a prerequisite for private
  acceptance testing.

## Consequences

The ChatGPT path reuses one MCP implementation, one authentication model, and
one producer-service policy boundary. No refactor or additional protocol tool
is required.

The private path depends on the operator's computer/network, PostgreSQL,
`tunnel-client`, MCP subprocess, ChatGPT task, and plugin connection. Each needs
liveness monitoring; a missing run is overdue, never a zero-finding success.
Developer Mode and tunnel/API-key creation are explicit account-security
operations. Secure MCP Tunnel is not a public plugin distribution mechanism.

## Rejected alternatives

- **Keep manual export as the only ChatGPT path:** no longer matches the
  supported installed-plugin capability.
- **Add a ChatGPT-only one-call MCP tool:** creates a second lifecycle policy
  surface and breaks the exact three-tool contract.
- **Add streamable HTTP solely for local testing:** duplicates a transport that
  the tunnel can already reach over stdio.
- **Expose the development server publicly:** expands the attack surface and
  introduces production authentication/deployment work not required for the
  private acceptance test.
