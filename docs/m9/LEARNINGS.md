# Milestone 9 learnings

- Portability is a relationship between a stable logical identity and
  append-only deployment bindings, not a provider-neutral string inside one
  mutable row.
- A preflight receipt is useful only when its definition and capability
  profile hashes are exact pins and the database verifies the same facts.
- Repository validation is insufficient for an activation boundary; direct
  SQL must independently reject missing safeguards and incompatible profiles.
- Canonical documents and projected columns must be cross-checked or an
  attacker can make the hash describe different state than the query surface.
- A sandbox-denied localhost bind is not a product failure, but the gate still
  must be rerun unchanged with loopback authority; it cannot be recorded as a
  pass from partial output.
- “At least one budget” is meaningful only after the database validates every
  budget element; checking array cardinality alone is not an activation guard.
