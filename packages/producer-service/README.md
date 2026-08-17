# Producer application service

This package is the generic Agent Feed producer policy boundary. It accepts
canonical protocol `0.1` requests, validates them through the published
`@agent-feed/schema` JSON contracts plus semantic checks, applies producer
authentication/scope and ingress security policy, then delegates lifecycle
writes to its injected adapter-neutral `ProducerPersistence` port. The
executable API composition root supplies `PostgresAgentFeedPersistence`; this
package does not depend on that concrete adapter.

It deliberately contains no SQL and no HTTP server. `apps/api` is the HTTP
adapter. A deployment can inject a generated schema validator through the
`ProtocolValidator` interface when it needs a different JSON Schema runtime;
the default validator still uses the published package's exported contracts.

`beginRunWithWireId` is the durable local-file/import boundary. It preserves
producer-visible run bundle IDs (including non-UUID strings) while PostgreSQL
keeps its internal UUID relational key. The wire-ID compatibility migration
must be applied before using that entrypoint.

Scope mismatches on existing runs are intentionally collapsed to
`run_not_found` to prevent tenant, producer, or stream enumeration. Path and
body `run_id` values are required to match before mutation.
Producer credentials require one exact producer ID and one or more exact stream
IDs; wildcard producer or stream credentials are rejected at startup. Add a
separate, explicitly modeled administrative role if cross-producer access is
ever required.
