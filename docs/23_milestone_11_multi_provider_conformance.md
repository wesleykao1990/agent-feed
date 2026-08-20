# Milestone 11 — multi-provider conformance

Status: **provider-neutral contract and five synthetic adapter fixtures green
locally; live-provider and durable-proof acceptance pending**

Milestone 11 makes evidence from different execution topologies comparable
without putting provider behavior into Agent Feed protocol `0.1`. The first
checkpoint is additive and does not close the remaining Milestone 10 production
work.

## Provider-neutral receipt and matrix

`packages/provider-conformance-core` defines a strict, payload-free receipt
that pins:

- one logical job key, immutable definition version and hash;
- one validation-policy version;
- scheduler, executor, ingress kind, deployment-binding hash, and exact
  capability-profile hashes;
- adapter identity and a digest of any external invocation identity;
- occurrence, execution, assessment, and delivery proof states; and
- the exact standard M8 telemetry inventory.

At least three distinct terminal topologies are required for a comparison
matrix. Unsupported telemetry is represented as a null value with explicit
`unknown` state and provenance. It is never inferred as zero. Unknown fields,
raw provider IDs, provider payloads, prompts, results, credentials, URLs, and
free-form metadata fail closed.

## First executable checkpoint

The focused test runs one logical job through five existing synthetic adapter
boundaries with injected lifecycle services:

1. ChatGPT manual export;
2. Claude hook;
3. generic MCP lifecycle routing, representing a workflow scheduler boundary;
4. REST ingress; and
5. local-file import, representing an offline runner boundary.

This proves that their normalized proof shapes can form one comparison matrix.
It does not prove that a provider scheduled or executed a task, that a custom
connector was authorized, that a receipt was persisted, or that a hosted
deployment is healthy.

## Protected boundaries

- Protocol `0.1` schemas and the three lifecycle tools are unchanged.
- Provider-specific behavior remains in adapters and execution-context
  sidecars.
- External invocation identity is digest-only in the shared contract.
- No Rewards Optimizer code, schema, database, or domain rule is included.
- M10 remains incomplete: dashboard integration, durable external identity,
  hosted HTTPS, alerts, recovery runbooks, and final acceptance are still open.

## Remaining acceptance slices

1. Persist conformance receipts as an append-only, tenant-scoped sidecar tied
   to exact M7–M9 proof identities.
2. Capture a live ChatGPT Scheduled Task receipt through its documented export
   or supported integration boundary.
3. Capture a live Claude custom-connector receipt and generic remote MCP
   receipt without storing account secrets.
4. Exercise durable PostgreSQL-backed REST, one real workflow scheduler, and a
   real local/offline runner through the same logical job.
5. Add only providers with a documented MCP, webhook, API, or export boundary.
6. Run independent hostile review, complete prior-milestone regression, and a
   published hosted CI gate.

Run the checkpoint with:

```sh
npm --prefix packages/provider-conformance-core ci
npm run m11:conformance
```

The successful runner message is intentionally limited to synthetic adapter
comparability. No live ChatGPT Scheduled Task, Claude account, durable
PostgreSQL, or production-hosting acceptance is claimed.
