# ADR-0007: Keep SDKs transport-injected and pin protocol separately from package version

Status: Accepted and implemented locally; hosted CI pending
Date: 2026-08-18

## Context

Milestone 3 requires TypeScript and Python producer and consumer SDKs. Agent
Feed has a frozen wire protocol `0.1`, while released packages use independent
semantic versions such as `0.1.1`. Producer REST is executable today, whereas
the consumer delivery API is intentionally transport-neutral and is not yet a
deployed HTTP server.

## Decision

Both SDKs expose typed producer and consumer operations over small injected
transport interfaces. HTTP convenience transports may be included, but they
must not imply that every transport-neutral handler is already deployed.

SDK packages pin the supported wire protocol to exact value `0.1`. Their
package version remains independent. TypeScript reuses public schema/package
types. Python ships generated or checked protocol models whose drift is
verified against the canonical schemas; it does not hand-author a competing
protocol.

The package candidates are `@agent-feed/sdk@0.1.1` and
`agent-feed-sdk==0.1.1`. Consumer operations remain transport-injected because
no consumer HTTP deployment is claimed in Milestone 3.

Retries are bounded and restricted to read-only operations or writes protected
by the protocol's idempotency keys. Errors and diagnostics never include
authorization values, signing keys, evidence excerpts, or complete payloads.

## Consequences

- SDK tests can run without a database or network.
- Applications can supply `fetch`, a test transport, or a future deployment
  transport without changing domain-facing calls.
- Consumer SDK support describes a contract boundary, not a production HTTP
  deployment claim.
- Protocol/package version confusion is testable and fails closed.

## Evidence required

- Clean build/test for the TypeScript package and Python package.
- Cross-language fixtures retain protocol `0.1` field names and nullability.
- Architecture tests reject server and database dependencies.
- Retry and redaction tests cover errors, timeouts, and abort behavior.
