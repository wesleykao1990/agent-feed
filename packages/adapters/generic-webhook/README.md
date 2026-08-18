# Generic webhook input adapter

`@agent-feed/generic-webhook-adapter` verifies a third-party webhook's raw
body, bounds and parses it, and invokes an explicit mapper that returns a
protocol `0.1` run bundle. The mapper is the trust boundary: upstream claims
remain untrusted observations and are not promoted to verified consumer facts.

```ts
const adapter = new GenericWebhookInputAdapter({
  service,
  principal,
  secret: process.env.WEBHOOK_SECRET!,
  mapper: (payload, context) => mapVendorPayload(payload, context),
});

await adapter.ingest({
  raw_body: rawRequestBytes,
  headers: requestHeaders,
});
```

The default signature header is `x-webhook-signature`. It accepts a raw
SHA-256 hex digest, `sha256=<hex>`, or `t=<unix-seconds>,v1=<hex>`; timestamped
signatures cover `timestamp + "." + raw_body` and default to a five-minute
replay window. Comparisons are constant-time. Input byte limits and strict
UTF-8/JSON parsing happen before mapping or lifecycle calls.

Every request must carry a stable `x-event-id` (or `x-webhook-id`) in the safe
identifier format. The adapter rejects process-local replays before mapping;
pass `replay_store` for an atomic durable claim/release boundary when protection
must survive restarts. The durable store must reject the same ID with a
different body digest. Only content type, event ID, and timestamp headers are
exposed to the mapper; authorization, cookies, signatures, and other raw
headers are excluded.

The adapter delegates begin, batch, completion, schema/security checks, and
authorization to the injected producer service through the validated local-file
bundle boundary. If a post-begin call fails, the bundle is closed as `partial`
when possible; otherwise a redacted error carries or persists exact resumable
recovery material. Invalid mapper output is reported as `bundle_invalid`,
separately from lifecycle failure. Secrets, raw payloads, and mapper exception
text are excluded from diagnostics.
