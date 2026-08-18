# ADR 0009 — Generic reference-consumer trust boundary

Status: Accepted and implemented; local and hosted CI green

Date: 2026-08-18

## Context

Agent Feed needs a runnable example showing how a downstream consumer receives
protocol findings without importing Agent Feed persistence or mistaking a
producer claim for domain truth. The Rewards Optimizer is a separate project,
so implementing its database, rules, evidence review, or deployment here would
invert ownership and create coupling.

## Decision

Keep a generic TypeScript reference at the roadmap's historical
`examples/rewards-optimizer/` path. It imports only the public SDK and requires
authenticated tenant, consumer, and stream scope from its caller. It maps
`finding.submitted` to an explicitly untrusted observation and exposes no
verification, canonical-evidence, promotion, or rule-writing operation.

Transport receipts use tenant/consumer-scoped `event_id` plus a canonical
fingerprint of immutable event content. Retry `attempt` may change; other drift
under one event ID fails closed. Semantic identity is separately versioned and
scoped to tenant, consumer, and stream. Submitted evidence, security flags,
handling restrictions, and unknown attributes remain cloned untrusted data.

The reference uses in-memory state only to demonstrate the ports. Production
authentication, durable receipt-before-ACK, retry/DLQ, source verification,
evidence policy, review, and domain writes belong to downstream applications.

## Rejected alternatives

- Implementing the Rewards Optimizer in this repository: rejected because it
  would duplicate and couple domain ownership.
- Direct Agent Feed PostgreSQL or private `/src` imports: rejected because they
  bypass public isolation and portability boundaries.
- Treating every reused event ID as harmless: rejected because payload drift
  can hide corruption or collision.
- Using `event_id` or `producer_dedupe_key` as semantic identity: rejected
  because transport retry and proposition equivalence are different concerns.

## Consequences and evidence

The example is runnable and portable but deliberately not production durable.
`npm run m4:conformance` builds/imports/packs the public artifact, runs focused
and public behavioral tests, and statically rejects database, SQL, server,
private-source, sensitive logging, and domain-promotion coupling. Exact results
are recorded in `docs/m4/ACCEPTANCE.md`.
