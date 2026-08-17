# Codex prompt — Agent Feed durable delivery

Begin only after Milestones 0 and 1 pass.

Implement the transactional outbox, queue worker, consumer subscriptions, signed webhook delivery, acknowledgements, retry/backoff, dead-letter state, and replay. External delivery is at-least-once; consumers must be idempotent.

Do not use Supabase Realtime as a queue. Realtime may be added only as an optional admin projection after queue delivery tests pass.

Prove consumer outage recovery, duplicate delivery safety, tenant isolation, signature/replay protection, and deterministic replay of dead-letter events.
