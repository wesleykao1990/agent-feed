# Delivery API application adapter

Status: **transport-neutral M2 handler acceptance is green; no HTTP server is
implemented in this package.**

`apps/delivery-api` contains transport-neutral handlers for the Milestone 2
consumer control surface. It is not an HTTP server: an HTTP, MCP, or other
transport adapter maps its request into `DeliveryApiRequest` and serializes
the returned status/body.

## Operations

The handlers cover:

```text
createSubscription
updateSubscription
listSubscriptions
pullPage
acknowledge
listDeadLetters
replayDeadLetter
```

All operations resolve a `ConsumerAuthContext` from the injected
`CredentialResolver`. The resolver receives only the opaque credential; tenant
and consumer fields in request bodies are rejected and never influence scope.
The handler constructs the pure consumer service with that scope and maps
cross-scope access to `404 not_found`.

No handler imports SQL, PostgreSQL, fetch, a web framework, Supabase, or
Rewards Optimizer code. Durable behavior is supplied by the injected
`DeliveryConsumerRepository`.

Production bootstrap code should call `createDeliveryApiHandlers` from the
package entry point with the credential resolver, repository, cursor codec, and
payload hasher. A PostgreSQL adapter can implement the repository without
being imported by this application package; the same composition seam is used
by integration tests.

Selectors use the normalized consumer-service contract: exact stream IDs,
finding-type OR matching, explicit routing-tag `any`/`all`, and explicit event
types. Selector updates are future-effective and invalidate old cursors by
selector version. Cursor encoding/decoding and idempotency hashing are
injected; production callers should use the protocol-runtime adapters rather
than adding crypto here.

## Decision and learning log

- Decision: request identity is a credential-resolver output, not a path or
  body field; this prevents tenant/consumer impersonation by parameter edits.
- Decision: the API layer only maps application errors to transport-neutral
  status codes. It does not duplicate authorization or delivery state logic.
- Decision: body scope fields are rejected early, making accidental client-side
  attempts to provide tenant identity visible instead of silently ambiguous.
- Learning: API tests should use fake repository/auth/cursor ports so they can
  prove isolation without starting a server or database.
- Learning: keeping repository composition at the package boundary lets the
  same handlers exercise a real persistence adapter without adding SQL to the
  transport layer.
- No unresolved implementation bugs were found in this adapter pass.

The package has 5/5 tests, a clean install, and a clean TypeScript build in
the combined M2 acceptance. Wiring these handlers to an HTTP server remains a
separate operational adapter and is not implied by the test result.

## Test

```sh
npm test
```
