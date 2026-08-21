# Milestone 12 learnings

- Consumer utility is a new claim layer; it must not retroactively change the
  producer finding or independent assessment.
- A disposition is history, not necessarily one terminal status.
- Exact ratios keep raw counts auditable and preserve zero-denominator absence.
- Recommendations and approvals are evidence; applying configuration remains a
  separate authorized operation.
- Polymorphic targets need database-side existence checks: finding feedback is
  tied to a tenant/run/finding identity, while artifact feedback additionally
  requires a sealed assessment receipt and matching digest.
- A transport must supply tenant, consumer, and approval authority as trusted
  context. Putting those fields back in request JSON would undo the boundary.
- Credential acceptance should report the authentication mode actually tested;
  cached Codex login and an exported OpenAI API key are independently testable.
- An isolated CI job that installs a source-linked package must explicitly install
  its complete locked local dependency graph. A developer workspace can mask a
  missing install because sibling package dependencies are already present.
