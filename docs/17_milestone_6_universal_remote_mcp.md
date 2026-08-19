# Milestone 6 — universal remote MCP gateway

Status: **implementation, live PostgreSQL, full regression, and hosted CI
acceptance green; Claude account acceptance waiting for an Owner or individual
Pro/Max session**

Milestone 6 adds a public Streamable HTTP composition for clients such as
Claude while preserving the existing stdio path used by ChatGPT Secure MCP
Tunnel. It does not add lifecycle methods or a Claude-specific producer
implementation.

## Implemented boundary

`apps/mcp-http` imports the official server factory from `apps/mcp-server` and
injects one trusted request-scoped producer principal after Bearer validation.
The same `ProducerService` still owns validation, rate policy, tenant/stream
scope, quarantine, idempotency, and PostgreSQL persistence.

The edge provides:

- MCP Streamable HTTP with modern `2026-07-28` and stateless legacy support;
- RFC 9728 protected-resource discovery and RFC 8414 authorization metadata;
- static scoped producer Bearer credentials for capable clients;
- an optional authorization-code + PKCE single-process pilot for Claude;
- dynamic registration for public PKCE clients;
- short-lived opaque access tokens, rotating refresh tokens, revocation, and
  one-use short-lived authorization codes;
- exact Host and optional Origin allowlists;
- a hard streamed request-body limit before protocol parsing;
- loopback binding behind an external HTTPS terminator; and
- a metadata-only health response.

The three public tools remain exactly `begin_run`, `submit_batch`, and
`complete_run`. Tool arguments cannot carry authentication fields.

## Acceptance ladder

1. `npm run m6:architecture` proves the dependency and trust boundaries.
2. `npm run m6:conformance -- --unit-only` runs build, adversarial OAuth/HTTP,
   and stdio regression checks without making a durability claim.
3. `npm run m6:conformance` requires a dedicated disposable PostgreSQL URL and
   must execute a full remote lifecycle through the Node HTTP listener.
4. The Claude receipt connects the public HTTPS URL, completes OAuth consent,
   discovers exactly three tools, and persists a begin/submit/complete run.

Steps 1–3 passed on 2026-08-18 with zero skipped HTTP, PostgreSQL, or stdio
tests. The public HTTPS health, protected-resource metadata, and authorization
metadata were also verified through a temporary acceptance tunnel. The active
Claude session is a Team/Enterprise member workspace; Anthropic exposes custom
connector registration there only to an Owner or Primary Owner, so step 4 is
waiting for an eligible account session rather than being recorded as failed.

The pre-Milestone 7 combined local gate passed on 2026-08-20. GitHub Actions
run `32299808263` then passed the complete validation, Milestone 4, Milestone
5, and Milestone 6 jobs at source commit `41d9b1e`. The M6 hosted job used a
clean checkout, rebuilt the generated schema dependency, and ran the live
PostgreSQL HTTP/OAuth and stdio regression gate.

## Explicit non-claims

The embedded authorization server is a single-process pilot and is not production acceptance.
Its clients, grants, and tokens are memory-only. A production or
multi-instance deployment needs a durable OAuth 2.1/OIDC provider, stable TLS
and DNS, durable secret rotation/revocation, monitored hosting, and a reviewed
availability model. The temporary acceptance tunnel is not stable hosting.

No Rewards Optimizer code or database is part of this milestone.
