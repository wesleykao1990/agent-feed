# Milestone 5A modularity and refactor-debt audit

Reviewed: 2026-08-18

## Boundaries

| Module | Owns | Must not own |
|---|---|---|
| `bin/agent-feed` | Executable entrypoint and exit status | Setup policy, credentials, MCP implementation |
| `apps/operator-cli/src/main.mjs` | Argument mapping and human-safe output | Database/MCP internals or account mutation |
| `apps/operator-cli/src/config.mjs` | Pure config validation, secret generation, and credential-free renderers | Filesystem, subprocess, database, or account mutation |
| `apps/operator-cli/src/operator.mjs` | Local runtime files, Compose invocation, doctor, MCP process composition | Protocol lifecycle policy, config grammar, or tunnel credentials |
| `apps/mcp-server` | Existing stdio MCP and shared producer service composition | Operator UX or a second credential store |
| `compose.yaml` | Private local PostgreSQL convenience | Production deployment or data deletion |

## Review result

- [x] Operator code uses Node built-ins only and has no package runtime
  dependency.
- [x] The root executable is a thin entrypoint; behavior remains directly
  testable.
- [x] Pure validation/rendering is separate from filesystem and process
  orchestration; the compatibility re-export avoids duplicate public surfaces.
- [x] The generated launcher contains only absolute paths and invokes the
  existing MCP implementation.
- [x] Runtime state is ignored, owner-only, contained, and symlink-safe.
- [x] Docker actions expose only `up`, `stop`, and `status`; no volume removal
  path exists.
- [x] Account-side tunnel and ChatGPT operations remain outside the module.
- [x] Static and behavioral gates are separate and wired to clean-checkout CI.

## Deferred work, not immediate refactor debt

Windows launcher support requires a platform-specific wrapper because this
slice emits a POSIX shell file. A deeper doctor could authenticate, inspect the
migration ledger, and run a reversible lifecycle probe, but it must use a
dedicated diagnostic identity and avoid mutating production streams. Neither
justifies splitting the current small operator module before those requirements
exist.
