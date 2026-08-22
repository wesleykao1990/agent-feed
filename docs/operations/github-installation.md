# Install Agent Feed from GitHub

Status: Milestone 5A local operator path
Reviewed: 2026-08-18

This is the shortest supported path from a clean GitHub checkout to a private,
PostgreSQL-backed Agent Feed MCP process. It keeps local secrets under the
ignored `.runtime/` directory, binds the bundled database only to localhost,
and never prints secrets. OpenAI tunnel creation, API keys, Developer Mode,
plugin installation, and Scheduled Task attachment remain explicit account-side
actions.

## Prerequisites

- Git;
- Node.js 22 or newer;
- Docker with Compose support for the bundled local PostgreSQL option; and
- macOS or Linux for the generated shell launcher.

The repository does not install Docker, Node.js, `tunnel-client`, or make
changes to an OpenAI account.

## Clone and configure

```sh
git clone https://github.com/wesleykao1990/agent-feed.git
cd agent-feed
bin/agent-feed setup --stream monitoring.example
```

`bin/agent-feed setup` installs only the MCP server's locked Node dependencies
and creates:

- `.runtime/operator/config.json`, containing the scoped producer and database
  configuration with owner-only permissions;
- `.runtime/operator/postgres.env`, containing generated local PostgreSQL
  credentials with owner-only permissions; and
- `.runtime/operator/bin/agent-feed-mcp`, a protocol-clean launcher containing
  paths but no credentials.

The setup output reports paths and next commands. It never prints secrets. The
default producer can write only to the stream supplied to `--stream`.

Start the private database and check the installation:

```sh
bin/agent-feed postgres up
bin/agent-feed doctor
```

The database is published only on `127.0.0.1:55432`. Its named Docker volume
survives `bin/agent-feed postgres stop`. The doctor checks Node, private file
permissions, configuration shape, MCP dependencies, and the configured
PostgreSQL network socket. Database authentication and migrations are exercised
when the MCP launcher starts; a passing socket check alone is not a full
end-to-end acceptance test.

## Use an existing PostgreSQL database

Put the PostgreSQL URL in a file that is readable only by its owner. This keeps
the credential out of command history:

```sh
chmod 600 /absolute/path/to/agent-feed-database-url
bin/agent-feed setup \
  --database-url-file /absolute/path/to/agent-feed-database-url \
  --stream monitoring.example
bin/agent-feed doctor
```

The URL must use `postgres://` or `postgresql://` and include an explicit
username, hostname, and database name. Agent Feed refuses a symlink, a group/world-readable credential
file, or conflicting `--database-url` and `--database-url-file` inputs.

## Connect ChatGPT privately

Use the generated absolute command as the Secure MCP Tunnel stdio target:

```text
/absolute/path/to/agent-feed/.runtime/operator/bin/agent-feed-mcp
```

Then follow [ChatGPT Scheduled Task MCP runbook](chatgpt-scheduled-task.md).
Tunnel and ChatGPT workspace association, runtime-key creation, Developer Mode,
plugin installation, and task attachment are explicit account-side operations;
the repository does not automate them. Run this additional fail-closed check
after installing and starting the official tunnel client. Use the health URL
file written by that tunnel runtime and the PID file written by its service
supervisor:

```sh
bin/agent-feed doctor \
  --require-tunnel \
  --tunnel-url-file /private/path/to/tunnel-health.url \
  --tunnel-pid-file /private/path/to/tunnel-client.pid
```

The command fails if either path is omitted, the PID is not running, either
health endpoint is unhealthy, or no authenticated control-plane poll has
completed. A profile-only `tunnel-client doctor` result is not sufficient for
an unattended ChatGPT schedule.

Do not use `npm start` as the tunnel's stdio command because package-manager
output can corrupt MCP JSON-RPC. Do not put database, producer, or tunnel
credentials in a ChatGPT prompt or plugin argument.

## Upgrade safely

Stop the local database, pull the reviewed revision, and rerun setup with the
explicit replacement flag:

```sh
bin/agent-feed postgres stop
git pull --ff-only
bin/agent-feed setup --force
bin/agent-feed postgres up
bin/agent-feed doctor
```

For an existing bundled database, `--force` preserves its database credentials,
port, producer identity, and producer secret unless the operator supplies an
explicit replacement. It never removes the named volume. Back up production
data using the PostgreSQL procedures for that deployment before an upgrade.

## Stop and diagnose

```sh
bin/agent-feed postgres status
bin/agent-feed doctor
bin/agent-feed postgres stop
```

`stop` is reversible and preserves the database volume. Agent Feed deliberately
has no one-command data deletion operation. Removing a runtime directory or
Docker volume is a separate destructive operator decision and is not part of
this runbook.

Stable CLI errors are intentionally concise so secrets, URLs, payloads, and
stack traces do not enter logs. When a check fails, fix the named boundary and
rerun `bin/agent-feed doctor`.
