# Milestone 10 refactor debt

- Do not replace the accepted M5 dashboard contract until the new PostgreSQL
  read adapter and authenticated tenant composition pass independently.
- Do not implement a home-grown production authorization server. Preserve the
  verifier boundary and integrate a durable standards-compliant external IdP.
