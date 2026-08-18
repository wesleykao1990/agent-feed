# Supabase reference decisions

## S-001 — Keep the canonical PostgreSQL migration history

The Supabase migrations `0001`–`0003` are byte-for-byte copies of
`packages/persistence-postgres/migrations`. The local verifier fails on drift.
This prevents a managed-database example from becoming a second, silently
diverging protocol schema.

## S-002 — Keep Agent Feed in a private schema

Core tables, outbox state, delivery attempts, and signing metadata remain in
`agent_feed`. Browser roles receive no schema usage or table privileges. The
optional health RPC is the only function granted to `service_role`.

## S-003 — Keep policy in the canonical API

The Edge Function is an HTTPS relay with route and header allowlists. It does
not reimplement authentication, schema validation, quarantine, idempotency,
or persistence. This prevents Supabase deployment convenience from creating a
second producer-ingress policy.

## S-004 — Realtime remains optional

Protocol correctness, liveness, and signed delivery use PostgreSQL state and
the delivery worker. No core table is exposed through Realtime.

## S-005 — Do not claim hosted acceptance

The repository proves migration parity and security boundaries locally. A
hosted Supabase deployment requires a user-owned project, credentials, a
reviewed migration receipt, and a recorded liveness proof.

## S-006 — Bound both sides of the Edge relay

The ingress function accepts at most 1 MiB from a producer and returns at most
2 MiB from the canonical API. Both `content-length` and streamed bytes are
checked, so a missing or dishonest length header cannot cause unbounded memory
use.
