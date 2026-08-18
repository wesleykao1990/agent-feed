# Operations-core bugs and limitations

## Open

- The package does not ship a PostgreSQL/Supabase/SQLite adapter. A storage
  implementation must be added before enabling destructive retention in a
  deployment.
- The current Agent Feed migrations protect accepted protocol rows, delivery
  receipts, and liveness history with append-only triggers and restrictive
  foreign keys. The package therefore only plans `managed_artifact` deletion.
  A production adapter needs an approved external-artifact cleanup strategy;
  the plan layer intentionally does not claim that database-row deletion is
  live.
- Audit details are metadata supplied by an adapter. The adapter must
  allow-list fields and must not copy untrusted evidence excerpts, secrets, or
  raw payloads into `details`.

## Fixed in this slice

- Retention plans now sort candidates and skips before deriving `planId`, so
  input query order does not change a plan.
- Dry-run execution no longer invokes the destructive adapter.
- Cross-tenant audit records fail closed rather than being silently filtered.
- A forged plan containing a core protocol entity, duplicate candidate, or
  more than 500 candidates is rejected before the destructive adapter is
  called.
- Planning now propagates candidate overflow instead of converting it into an
  `invalid_record` skip; execution recomputes the plan fingerprint.
- Audit exports reject over-budget record/byte counts and nested sensitive
  metadata key substrings.
- Audit sort ties now fall back to canonical normalized bytes, eliminating
  input-order-dependent hashes.
- Safe-looking metadata keys no longer bypass the export filter when their
  values contain authorization schemes, URL user information, sensitive query
  parameters, signed tokens, or recognizable provider API keys.
