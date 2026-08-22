# Agent Feed webhook adapter

This package is the network boundary for outbound Agent Feed webhooks. It
does not own subscriptions, retries, SQL, or consumer-domain behavior.

The package has 10/10 tests, a clean install, and a clean TypeScript build in
the combined M2 acceptance. It is a deterministic transport adapter; a
production worker process and exporter are owned by later operational work.

## Safety boundary

- HTTPS and the default port are required by default;
- endpoint credentials, fragments, and query strings are rejected;
- every DNS address is resolved and checked before each request;
- loopback, private, link-local, multicast, metadata, documentation, and
  private IPv4 embedded in mapped, IPv4-compatible, 6to4, or well-known NAT64
  IPv6 addresses are rejected;
- validated addresses are passed to the HTTP client to prevent DNS rebinding;
- the built-in HTTP client tries at most four of those pinned addresses when a
  connection fails before any HTTP response; it never re-resolves DNS;
- redirects are never followed;
- request and response bodies are bounded before endpoint/DNS or HTTP work;
- requests have an abortable timeout;
- failure errors contain stable codes/messages only and never include secrets,
  URLs, or response bodies, including when errors cross package or VM
  boundaries.

Production callers should inject a secret/key resolver into the signer and an
endpoint resolver into `WebhookTransport`. No secret material is read or
stored by this package.

## Failure mapping

Endpoint policy failures, private-address answers, body-limit violations, and
redirects are permanent delivery failures. DNS/network errors and timeouts are
retryable. HTTP `2xx` is an acknowledgement; `408`, `425`, `429`, and `5xx`
are retryable (with a bounded `Retry-After` value when present), while other
statuses are permanent. The adapter returns a bounded response-body hash for
audit correlation and never returns the response body itself.

The resolver and HTTP request share one configured timeout and abort signal.
This matters for custom DNS/endpoint resolvers as well as the built-in client:
a resolver or a sequence of pinned connection attempts that does not complete
cannot hold a worker lease indefinitely. An HTTP response (including a 4xx,
5xx, or redirect) ends the address sequence; only a connection-level failure
before response headers permits the next pinned address. The injected network
fakes in the test suite are deliberately deterministic; tests use only local
loopback sockets and never open an external socket.
