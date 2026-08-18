# Agent Feed Python SDK

Stdlib-first Python 3.11+ clients for Agent Feed protocol `0.1` (package
version `0.1.1`). The package
has no runtime dependencies: HTTPS uses `urllib`, JSON uses `json`, and the
retry/timeout layer is injectable for applications and tests.

The SDK is deliberately domain-neutral. It contains no reward, stock, job, or
consumer-domain models.

## Install

```sh
python3 -m pip install ./packages/sdk/python
```

For a checkout-only run:

```sh
PYTHONPATH=packages/sdk/python python3 -m unittest discover -s packages/sdk/python/tests -v
```

## Producer lifecycle

Producer request bodies use the exact protocol wire names and are validated
before transport. A model is optional; ordinary dictionaries work too.

```python
from agent_feed import ProducerClient

client = ProducerClient("https://feed.example", token="producer-secret")
run = client.begin_run(begin_request)                 # POST /v1/runs:begin
run_id = run["run_id"]
client.submit_batch(run_id, submit_batch_request)     # POST /v1/runs/{id}/batches
client.complete_run(run_id, complete_request)         # POST /v1/runs/{id}:complete
```

`begin_run`, `submit_batch`, and `complete_run` are idempotency-keyed by the
protocol and receive bounded retries for transport failures and HTTP 408,
425, 429, 5xx responses. Non-idempotent operations are never retried by
default. `get_run` and `get_findings` are safe GETs and may be retried.

The same methods are available as `beginRun`, `submitBatch`, and
`completeRun` for parity with the existing TypeScript API. A portable bundle
can be built without another network call:

```python
bundle = client.build_run_bundle(begin_request, [batch_request], complete_request)
```

For an in-progress `ProducerRun`, only batches whose submit call returned
successfully are retained. `run.bundle()` intentionally requires a successful
terminal completion. If a process must preserve begun/partial progress after
an interrupted submit or completion, use the explicit local recovery export:

```python
partial = run.recovery_bundle(
    idempotency_key="recovery-key-2026-08-18",
    completed_at="2026-08-18T01:00:00Z",
)
```

The resulting protocol-`0.1` bundle has `complete.status == "partial"`; it
does not call the service's complete endpoint. Failed in-flight batches are
omitted, and conservative empty scope/source counts are used unless
`actual_scope`, `stats`, or `errors` are supplied. The same operation is
available as `partial_bundle`, `ProducerClient.build_recovery_bundle`, and
`create_recovery_bundle`. Both `idempotency_key` and `completed_at` are
required: persist and reuse the exact returned bundle for every retry so one
key can never drift to a different terminal timestamp.

## Consumer delivery API

`ConsumerClient` mirrors the existing delivery-consumer application inputs:
`name`, `selectors.streamIds`, `selectors.findingTypes`,
`selectors.routingTags`, `selectors.eventTypes`, and `delivery.mode` remain
camelCase at this application boundary. Its methods are:

```python
consumer.create_subscription(create_input)
consumer.update_subscription(update_input)       # subscriptionId in input
consumer.list_subscriptions()
consumer.pull_page("sub-1", {"limit": 50})
consumer.acknowledge("sub-1", ["d-1"], {"idempotencyKey": "ack-1"})
consumer.list_dead_letters("sub-1")
consumer.replay_dead_letter("sub-1", "d-1", {"idempotencyKey": "replay-1"})
```

The camelCase aliases (`createSubscription`, `pullPage`, `acknowledge`, and
the rest) are also exposed. Pull/list operations are safe GETs. ACK and replay
are idempotency-keyed and retry-safe. Subscription creation/update is not
retried because the existing API does not require an idempotency key for those
mutations.

The repository's consumer API is transport-neutral. The default paths follow
the documented delivery API (`/v1/consumers/{consumer_id}/subscriptions`,
`/events`, `/events/{delivery_id}:ack`, `/dead-letters`, and
`/dead-letters/{delivery_id}:replay`) and carry `subscription_id` as the
documented query parameter. Override them with `ConsumerPaths` for a gateway
that uses a different prefix.

## Validation and models

`agent_feed.generated.protocol` is the checked-in `TypedDict` artifact produced
from `packages/schema/contracts/*.schema.json`. `agent_feed.models` provides
mapping-compatible frozen dataclasses (`BeginRunRequest`, `Finding`,
`SubmittedEvidence`, `RunBundle`, and all other protocol roots) that validate
on construction. `agent_feed.validate(value, "begin" | "submit-batch" | ...)`
is the direct validator entrypoint.

The dependency-free schema-drift test parses the canonical contract JSON and
the generated `TypedDict` AST, checking every generated root/nested object
field set. Run it with the package tests from this checkout; installed wheels
continue to use the checked-in generated artifact without requiring the repo.

Validation enforces protocol `0.1` constants, required/closed snake_case
objects, scalar types, enums, date-time/URI formats, bounds, unique arrays,
and the non-empty submit-batch rule. It returns a detached copy; callers cannot
mutate a validated request after it has been prepared for transport.

## Transport, timeout, and diagnostics

Inject a transport implementing:

```python
def request(method, url, *, headers, body, timeout) -> TransportResponse: ...
```

`TransportResponse` can contain a JSON-compatible body. This makes local fake
servers, tracing, and async/thread adapters possible without importing server
or database internals. `UrllibTransport` is the default HTTPS implementation.

`RetryPolicy(max_attempts=3, initial_delay=0.25, max_delay=2.0)` is bounded to
eight attempts. It accepts an injected `sleep` function and honors numeric
`Retry-After` values, capped by `max_delay`. Exceptions are typed
(`ValidationError`, `AuthenticationError`, `AuthorizationError`,
`ConflictError`, `NotFoundError`, `RateLimitError`, `TimeoutError`,
`TransportError`, `RetryExhaustedError`, and `ServerError`). Error diagnostics
redact bearer credentials, tokens, secrets, cookies, and sensitive fields;
response bodies are bounded before being exposed through `details`.
