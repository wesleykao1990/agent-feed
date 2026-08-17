# Security and privacy

## Pinned v0.1.1 transport defaults

- inbound authentication: per-producer service credential bound to allowed stream IDs;
- outbound event signature: HMAC-SHA256 over `timestamp + "." + raw_body`;
- accepted timestamp skew/replay window: 300 seconds;
- signing-key rotation overlap: 24 hours, with explicit key IDs;
- maximum request body: 1 MiB;
- maximum batch: 100 findings and 100 submitted-evidence records;
- maximum inline evidence excerpt: 4,000 UTF-8 characters;
- maximum inline artifact metadata: 64 KiB; larger artifacts use object storage;
- default producer rate limit: 60 requests/minute with a burst ceiling of 10;
- duplicate idempotency key with a different payload hash: HTTP 409 / protocol conflict;
- terminal runs and accepted batches/findings/evidence are immutable;
- secrets or hostile embedded instructions cause quarantine before consumer delivery.
- consumer credentials are tenant/consumer scoped; a URL or request body must
  never select another consumer's subscription;
- delivery cursors are authenticated, opaque, expiring, and bound to tenant,
  consumer, subscription, and selector version;
- retries/replays preserve event ID and payload hash, and signatures are
  recomputed for the body-level attempt number;
- metric labels are allowlisted and bounded; source content, evidence, secrets,
  arbitrary routing tags, and raw errors are not labels.

These are versioned defaults, not universal limits. A deployment may tighten them, but weakening them requires a recorded security decision and tests.

The protocol `0.1` evidence schema retains its original 5,000-character wire
ceiling for compatibility. The service default is deliberately stricter at
4,000 characters and is enforced before persistence.

## Data handling

- authenticate every producer and bind credentials to allowed streams;
- authenticate consumers separately and filter their subscriptions;
- use idempotency keys, payload hashes, request timestamps, and replay protection;
- reject known secret fields and impose body, batch, artifact, and excerpt limits;
- minimize personal data and support tenant-scoped retention/deletion;
- store large artifacts outside row payloads and scan uploads before use;
- treat URLs, excerpts, HTML, PDFs, and model output as untrusted;
- do not expose internal queues or service credentials to browser clients;
- log protocol metadata, not unnecessary source content or secrets.

The protocol-runtime foundation tests canonical bytes, HMAC replay checks,
strict snake_case event bodies, key rotation, and trace-header binding. The
consumer service, transport-neutral API, PostgreSQL repository, and webhook
adapter have focused foundation tests, but durable PostgreSQL and HTTP server
security integration are not live-verified. See the M2 go/no-go checklist.
