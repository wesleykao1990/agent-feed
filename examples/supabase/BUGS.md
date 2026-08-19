# Supabase reference bugs and limitations

| ID | State | Limitation | Safe handling |
| --- | --- | --- | --- |
| S-BUG-001 | Open by design | This repository cannot create or verify a hosted Supabase project without user-owned credentials. | Treat `tests/verify.mjs` as a static/local gate only; record hosted receipts separately. |
| S-BUG-002 | Open by design | The Edge Function does not persist directly. | Point `AGENT_FEED_INGRESS_URL` at the canonical durable API configured with the Supabase server-side database URL. |
| S-BUG-003 | Resolved in reference | A broad `service_role` table grant would make the optional function more powerful than necessary. | Migration `0004` grants only `health()` execution; the static gate rejects broad table/sequence grants. |
| S-BUG-004 | Resolved in reference | Forcing RLS would also constrain a trusted PostgreSQL owner connection used by the canonical API. | RLS is enabled but not forced; browser roles have no schema usage, while deployment roles remain explicit. |
| S-BUG-005 | Resolved in reference | The first relay draft bounded producer requests but buffered an unbounded upstream response. | Enforce both declared and streamed response limits before returning upstream bytes. |
