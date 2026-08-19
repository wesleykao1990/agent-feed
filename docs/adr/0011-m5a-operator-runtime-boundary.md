# ADR-0011: Keep GitHub setup local, private, and separate from account operations

Status: Accepted
Date: 2026-08-18

## Context

The accepted Agent Feed packages were buildable, but a GitHub user still had
to manually assemble a PostgreSQL service, scoped producer credentials, MCP
dependencies, and a clean stdio command. The existing live ChatGPT setup also
showed that package-manager output can corrupt MCP and that tunnel/workspace
association is a distinct account boundary.

## Decision

- Add a Node built-in-only operator CLI with `setup`, `doctor`,
  `postgres up|stop|status`, and `mcp` commands.
- Store generated database and producer credentials only in ignored,
  owner-readable runtime files and keep the generated MCP wrapper secret-free.
- Offer localhost-only PostgreSQL Compose for development and an owner-only
  credential-file path for an existing PostgreSQL database.
- Launch the existing MCP server directly with an exact scrubbed environment;
  do not add another MCP implementation.
- Preserve generated database and producer identity during forced upgrades.
- Do not create or manage OpenAI tunnels, API keys, Developer Mode, plugins, or
  Scheduled Tasks from the repository CLI.

## Consequences

A clean GitHub checkout has one supported local path and a testable handoff to
Secure MCP Tunnel. The default remains private and normal CLI lifecycle actions
cannot remove PostgreSQL data. Operators still make explicit account-security
changes and remain responsible for backups and production deployment.

The generated launcher is POSIX-only in this slice. `doctor` proves local
configuration and reachability, not a full lifecycle transaction.

## Rejected alternatives

- **Automate tunnel and plugin creation:** crosses account identity and approval
  boundaries and would require storing additional credentials.
- **Use `npm start` as the generated command:** writes non-protocol output to
  MCP stdout.
- **Put secrets in the wrapper or command line:** exposes them through files,
  history, or process inspection.
- **Make `docker compose down --volumes` a convenience command:** turns a normal
  lifecycle operation into destructive data removal.
- **Create a second operator-specific MCP server:** duplicates the accepted
  shared producer policy and protocol surface.
