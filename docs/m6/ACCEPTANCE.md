# Milestone 6 acceptance evidence

Status: **local unit/architecture, live PostgreSQL, full prior-milestone
regression, and hosted CI green; Claude account receipt waiting for eligible
account access**

The local focused gate covers official MCP HTTP dispatch, exact tool
discovery, trusted-principal injection, hostile credential arguments, OAuth
DCR/consent/PKCE/code replay/refresh/revocation, Host/Origin rejection, body
limits, and the existing stdio MCP regression.

On 2026-08-18, `npm run m6:conformance` passed against the dedicated
`agent_feed_m6_acceptance_20260818` PostgreSQL database: 8 architecture
boundaries, 6/6 remote HTTP/OAuth/durability tests with zero skips, and 11/11
stdio MCP regressions. The HTTP lifecycle persisted terminal producer/stream
identity, one finding, and one evidence record.

A Cloudflare Quick Tunnel then served the loopback gateway over HTTPS. Public
health, RFC 9728 protected-resource metadata, and RFC 8414 authorization
metadata returned successfully. This is an acceptance transport only and is
not production hosting evidence.

The selected Claude account is a Phrase Team/Enterprise member workspace.
Anthropic permits only an Owner or Primary Owner to register a new custom
connector for that organization, and the session exposes no Organization
settings. The Claude tool-discovery and lifecycle receipt is therefore waiting
for an individual Pro/Max session or organization Owner action; it has not been
misreported as a connector failure.

## Pre-Milestone 7 integration gate

On 2026-08-20, Milestone 5 PRs #6 and #7 were merged in dependency order and
the Milestone 6 branch was fast-forwarded to integrated `main` commit
`3af9be3`. A fresh combined local validation then passed:

- foundation validation, checksum/type/protocol compatibility, 29 prototype
  tests, 23 protocol/conformance tests, and 3 schema-artifact tests;
- Milestone 1 live PostgreSQL ingress: 6/6;
- the complete Milestone 2 delivery gate, including 3/3 live PostgreSQL tests;
- the complete Milestone 3 TypeScript/Python/adapter gate;
- the complete Milestone 4 reference-consumer gate;
- the complete Milestone 5 portability/operations gate, including live
  PostgreSQL and PostgreSQL-compatible Supabase proof; and
- Milestone 6: 8 architecture boundaries, 6/6 HTTP/OAuth/PostgreSQL tests, and
  11/11 stdio MCP regressions.

Each live milestone used a separate explicitly named disposable database. The
first sandboxed attempts that could not open localhost sockets were environment
failures and were rerun successfully with localhost access; they are not
counted as product regressions.

GitHub Actions run `32299808263` passed all four PR #8 jobs at source commit
`41d9b1e`: complete validation, Milestone 4 reference consumer, Milestone 5
portability/operations, and Milestone 6 remote MCP. The hosted M6 job performed
the complete source-link clean install, rebuilt the generated schema package,
and passed the live PostgreSQL HTTP/OAuth plus stdio gate.
