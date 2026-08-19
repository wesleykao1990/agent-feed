# Milestone 5 learnings

## M5-L001 — Installation is an owned product boundary

A clean build does not mean a new operator can safely compose credentials,
PostgreSQL, and an MCP launcher. The supported path needs tests, stable errors,
upgrade behavior, and documentation like any other public interface.

## M5-L002 — “Force” must preserve persistent-service identity

Replacing a client-side password file does not update a PostgreSQL role inside
an existing volume. Safe setup upgrades preserve generated identity and secrets
unless rotation is an explicit coordinated operation.

## M5-L003 — Private permissions are not enough without path containment

Applying `0700` to an untrusted parent path can damage unrelated filesystem
access, and overwriting a symlink can escape the runtime. Generated paths must
be contained and symlinks rejected.

## M5-L004 — A clean MCP wire starts below package-manager output

The tunnel target should execute the Node process directly. Even harmless npm
banners on stdout are invalid bytes on the JSON-RPC stream.

## M5-L005 — Account automation and repository automation have different owners

Local setup can create private configuration, but tunnel identities, keys,
Developer Mode, plugins, and scheduled tasks mutate an account security
boundary. They remain explicit operator actions.

## M5-L006 — A doctor must name the depth of each check

A successful TCP connection proves only that the configured host and port are
reachable. Documentation must not inflate it into authentication, migration,
or end-to-end lifecycle evidence.

## M5-L007 — A child process should not inherit the operator's secret universe

Overwriting known Agent Feed variables is insufficient when the parent also
holds a tunnel control-plane key or unrelated cloud credentials. The MCP child
needs an allowlisted operating environment plus its exact scoped Agent Feed
configuration.

## M5-L008 — Sample-secret checks need a positive and negative fixture

Length alone cannot distinguish a safe long placeholder from a credential.
Static guards should recognize explicit placeholder language and prove that a
real-looking value still fails closed.

## M5-L009 — Validation prerequisites belong to the declared environment

A system Python can change independently of the repository and omit its wheel
backend. The complete M3 proof must run through `requirements-dev.txt`, as CI
does, instead of relying on whatever packages happen to be globally installed.

## M5-L010 — `undefined` is still a value during object spread

Command parsers commonly materialize optional fields with `undefined`. A
configuration upgrade must remove those absent entries before layering explicit
operator choices over preserved state, or safe defaults can silently replace a
working custom identity.
