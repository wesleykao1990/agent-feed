# Agent Feed protocol runtime

This package contains dependency-light, protocol-only runtime helpers for
Agent Feed delivery. It has no dependency on the prototype, PostgreSQL, an
HTTP server, Supabase, or any consumer domain.

## Responsibilities

- one canonical JSON implementation for hashes and signatures;
- SHA-256 and HMAC-SHA256 over `timestamp.body`;
- the pinned 300-second replay window;
- key-ring lookup, validity intervals, and 24-hour rotation overlap;
- exact snake_case Delivery Event `0.1` encoding/decoding;
- signed-delivery transport headers, including event, delivery, attempt,
  protocol, key, timestamp, signature, and optional W3C trace headers.

The strict event body contains only the fields in
`packages/schema/contracts/delivery-event.schema.json`. Signature metadata is
returned separately as headers. `rawBody` is the exact canonical string that
must be sent; reserializing the parsed event can invalidate the signature.
The `x-agent-feed-signature` header is the lowercase hexadecimal HMAC digest
over `timestamp.rawBody`; the verifier accepts hexadecimal case-insensitively.

## Key rotation

Key validity uses half-open intervals `[activeFrom, expiresAt)`. Calling
`KeyRing.rotate` activates the new key immediately and expires currently valid
predecessors at most 24 hours later. The key ID is required for verification;
the key secret is never included in metadata or transport headers.

## Development

```sh
npm test
npm run build
```
