# Supabase reference learnings

- Managed PostgreSQL does not remove the need for an application boundary.
  Direct row insertion would bypass producer authentication, protocol checks,
  idempotency conflict handling, and quarantine policy.
- Supabase's generic JWT switch is not equivalent to Agent Feed's scoped bearer
  credential. The relay leaves JWT verification disabled and requires the
  canonical service to authenticate the producer.
- RLS is useful defense in depth only when role ownership is understood. An
  owner connection and `service_role` have different bypass behavior; the
  migration avoids `force row level security` and does not grant either role
  broad browser-facing table access.
- A migration copy is only safe when drift is detected. The verifier compares
  each copied canonical migration byte-for-byte rather than checking a few
  schema names.
- A static deployment example is not operational proof. The remaining hosted
  acceptance needs a project-specific migration receipt, health response,
  liveness sweep result, and rollback record.
- Request-size protection is incomplete when a relay still buffers an
  unbounded upstream response; limits must cover declared and streamed bytes in
  both directions.
