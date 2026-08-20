# Assessment-core learnings

- Independent proof is an authority decision, not a string a producer can put
  in its own assessment. Keep the authority lookup outside the submission hash.
- `unknown` is a first-class operational state. Coercing absent token, cost, or
  network telemetry to zero produces false receipts and breaks provider-neutral
  comparisons.
- Canonical sorting is needed for budgets, usage observations, and artifact
  references because adapters may return those rows in different orders.
- A SHA-256 and an opaque reference are enough for a durable receipt; accepting
  blobs, data URLs, signed URLs, or credentials would turn the proof sidecar
  into an unsafe content store.
