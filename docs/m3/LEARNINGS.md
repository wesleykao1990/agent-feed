# Milestone 3 engineering learnings

Status: accepted; hosted CI green
Started: 2026-08-18

This is an append-only record of facts learned during implementation and
integration.

## M3-L001 — A shared method signature is not enough to prove a shared boundary

MCP and REST could expose similarly named lifecycle operations while applying
different validation or authorization. The gate must inject one service spy or
real service into both transports and prove that the same public methods and
principal-derived scope are used. Static import checks supplement, but do not
replace, this behavioral proof.

## M3-L002 — Producer failure handling depends on when durability began

Input that fails before `begin_run` should have no lifecycle side effects.
Failure after begin is different: the adapter now owns a durable run identity
and must either close it with actual progress or return/persist enough exact
material to recover. A single generic catch block cannot correctly handle both
states.

## M3-L003 — Consumer SDK support and consumer HTTP deployment are separate facts

The accepted Milestone 2 API is transport-neutral. An SDK can provide an
injected consumer transport and typed operations without claiming an HTTP
server exists. Documentation and examples must preserve that distinction until
an operational adapter is actually deployed.

## M3-L004 — Tool-less export is a supported path, not an error mode

The run-bundle schema already provides a complete lifecycle envelope. Manual
and scheduled-task fallback output should therefore be validated as a normal
producer artifact, with stable IDs and idempotency keys, rather than treated as
an informal copy/paste format.

## M3-L005 — MCP protocol revision and Agent Feed wire protocol are independent

Agent Feed payloads remain protocol `0.1`, while the MCP transport has its own
date-based revision. The current MCP `2026-07-28` era removes the legacy
initialize/session model in favor of optional discovery and a per-request
metadata envelope. Documentation, negotiation tests, and dependency locks must
name both versions explicitly so upgrading one is never mistaken for changing
the other.

## M3-L006 — Reusable transport and executable app are separate package roles

The first REST pass reproduced the existing API router. The more durable shape
puts request framing/routing in one reusable adapter and leaves `apps/api` to
compose credentials, producer service, and PostgreSQL while preserving its
accepted public entrypoint. A modularity audit must compare implementations,
not merely check that package names differ.

## M3-L007 — Conformance must enter through the public executable boundary

A deterministic internal facade is useful for narrow fixtures, but it cannot
prove MCP revision negotiation, stdio framing, or official SDK integration.
The acceptance path must call the same exported server function that a real
process uses.

## M3-L008 — Packaging is a separate test dimension from importability

Python source can import and pass unit tests while its wheel build fails because
the build backend is unavailable or source-tree metadata contaminates the
result. Building from an isolated copy catches this without dirtying the
checkout.

## M3-L009 — Sandbox network denial must be distinguished from a test failure

A loopback bind rejected with `EPERM` before assertions is execution-environment
evidence, not a functional regression. Re-running the exact command with the
required permission preserves the test rather than weakening or skipping it.

## M3-L010 — Recovery confidentiality is an operational property

Public errors should never echo inputs, but deterministic recovery sometimes
must retain them. Recovery stores therefore need secret-grade access controls,
retention, and deletion rather than lossy redaction that prevents replay.

## M3-L011 — A public TypeScript package needs an external runtime proof

`tsc --noEmit` proves source types but not that `npm install` yields executable
JavaScript. A publishable SDK gate must pack the declared files, install that
archive in an empty consumer, and import it with ordinary Node rather than the
repository's TypeScript stripping flags.

## M3-L012 — Error properties participate in accidental data exfiltration

A redacted message is insufficient when a sensitive recovery bundle is an
enumerable property: structured loggers commonly serialize the whole error.
Sensitive operational artifacts need explicit access plus serialization-safe
property descriptors and `toJSON()` behavior.

## M3-L013 — Content hashes are not occurrence identities

Two scheduled tasks can legitimately emit the same text. Idempotency identity
must also cover stable task/stream context and occurrence time, while retries
must reuse one exact artifact rather than regenerate time-dependent payloads.

## M3-L014 — Webhook freshness and webhook replay are different controls

An HMAC timestamp bounds age but does not make an event unique. A stable event
ID plus an atomic claim is required; production deployments that need restart
durability must inject the documented replay store.

## M3-L015 — A composition root inherits source-linked build prerequisites

Installing a local `file:` dependency at the application root does not prove
that TypeScript can resolve that dependency's own source imports from a clean
checkout. CI must install every source-linked package before compiling the
composition root; populated developer `node_modules` directories are not
acceptable build evidence.

## M3-L016 — Integration-test clocks must share an explicit epoch

A hard-coded claim timestamp can silently become earlier than a database row's
real `now()` insertion time as the calendar advances. Time-sensitive database
tests should establish one explicit epoch from the database clock and derive
their synthetic operation sequence from it; production scheduling must not be
changed to accommodate a stale fixture date.
