# Learnings

- Provider conformance is structural comparability, not a requirement that
  providers produce identical outcomes or telemetry.
- Existing adapters can share a receipt contract without importing provider
  behavior into protocol `0.1`.
- Synthetic adapter fixtures are useful contract evidence but must remain
  clearly separate from live-account and durable-database receipts.
- One comparison matrix can cover adapters with very different transport
  framing as long as lifecycle and proof identity are normalized after the
  adapter boundary.
