# ADR-0006: Share one producer application boundary across REST, MCP, and adapters

Status: Accepted and implemented locally; hosted CI pending
Date: 2026-08-18

## Context

Agent Feed already has a durable REST adapter in `apps/api` and an
adapter-neutral lifecycle boundary in `@agent-feed/producer-service`.
Milestone 3 adds MCP and several producer adapters. Reimplementing validation,
authorization, security checks, idempotency, or terminal-state policy in each
transport would create inconsistent acceptance behavior and force a later
refactor.

## Decision

REST, MCP, local-file, generic-webhook, Claude-hook, and manual-export import
paths delegate lifecycle operations to the public producer application
boundary. Transport code may parse framing, authenticate a caller into a
`ProducerPrincipal`, limit input bytes, and map errors, but it must not import
PostgreSQL adapters, issue SQL, or reproduce lifecycle policy.

Executable composition roots may construct PostgreSQL persistence and inject
it into the producer service. That dependency is confined to composition;
tool handlers and adapter packages remain persistence-neutral.

## Consequences

- REST and MCP can be tested against the same service spy and the same durable
  service implementation.
- Security and idempotency fixes land once in the application boundary.
- An adapter cannot bypass tenant, producer, or stream authorization by
  supplying scope fields in its payload.
- Static architecture checks reject database imports and direct source-subpath
  imports from Milestone 3 packages.
- The public executable MCP path uses the official TypeScript MCP server and
  serves the `2026-07-28` era while retaining tested legacy compatibility.
  The internal deterministic facade is test-only and is neither exported nor
  used by the executable server.

## Evidence required

- Behavioral conformance proves REST and MCP invoke the same service contract.
- Each adapter has failure-path tests and no database/server-internal imports.
- The combined Milestone 3 gate runs the existing live PostgreSQL ingress and
  delivery suites unchanged.
