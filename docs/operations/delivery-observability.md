# Durable delivery observability

Status: **M2 metric/trace contract accepted; production exporter/deployment remains future work**

The worker and API must expose protocol metadata and delivery health without
logging untrusted source content or secrets. The delivery-core worker emits a
small set of transport-neutral metric events through an injected `MetricsSink`,
and `InMemoryMetricsSink` can cap series and allowlist names/keys/values for
tests. The delivery-worker composition/loop exists, but no production
exporter, deployment entrypoint, or live metrics path is present; metric names
below remain the contract to implement at the process boundary.

## Metrics

Recommended counters:

- `agent_feed_delivery_attempts_total{consumer_id,subscription_id,status}`
- `agent_feed_delivery_retries_total{consumer_id,subscription_id,reason}`
- `agent_feed_delivery_acknowledgements_total{consumer_id,subscription_id,result}`
- `agent_feed_delivery_dead_letters_total{consumer_id,subscription_id,reason}`
- `agent_feed_delivery_replays_total{consumer_id,subscription_id,reason}`
- `agent_feed_delivery_signature_failures_total{consumer_id,reason}`

Recommended gauges/histograms:

- `agent_feed_delivery_pending_events{consumer_id,subscription_id}`
- `agent_feed_delivery_oldest_pending_age_seconds{consumer_id,subscription_id}`
- `agent_feed_delivery_active_leases{worker_id}`
- `agent_feed_delivery_attempt_latency_seconds{consumer_id,subscription_id}`
- `agent_feed_delivery_ack_latency_seconds{consumer_id,subscription_id}`

Labels must be bounded. Do not use event titles, summaries, URLs, evidence
content, arbitrary routing tags, authorization headers, or raw error strings as
labels.

## Current implementation evidence and gate

- The delivery-core metrics sink and worker-label tests are included in the
  package's 18/18 test suite, and the combined M2 acceptance is green.
- The current worker helper emits only a bounded event-type label; it does not
  yet provide a production-wide allowlist for metric names, label keys, or
  values.
- A generic `MetricsSink` implementation is intentionally injectable, so this
  pure package cannot claim that every exporter is bounded.

Before production observability deployment, the worker/exporter adapter should
define a fixed allowlist, collapse unknown values, reject or redact
source-derived labels, and prove bounded series under adversarial event types,
consumer IDs, subscription IDs, errors, and routing tags. This exporter work
is future operational scope; the bounded implementation contract is accepted
for M2.

## Trace lineage

Every accepted event should be correlatable through:

```text
event_id / internal trace ID
  -> outbox row
  -> subscription match
  -> attempt number and lease
  -> webhook or pull response
  -> acknowledgement or dead letter
  -> replay attempt
```

Until a protocol-level `trace_id` is approved, event ID is the authoritative
signed wire lineage and any separate trace ID is internal metadata. Trace IDs
must not be used to authorize a consumer or expose another tenant's data.

## Logs

Structured logs may include deployment, worker, consumer/subscription,
event/trace ID, attempt, status, bounded latency, and a redacted error code.
They must not include full event bodies, evidence excerpts, source URLs when
privacy-sensitive, bearer tokens, HMAC secrets, or arbitrary metadata.

## Alerts

Alert thresholds should be deployment-specific, but the initial alert set
should cover:

- oldest pending age above the consumer's service objective;
- sustained queue growth;
- expired leases above a small baseline;
- dead-letter increase;
- repeated signature/authentication failures;
- webhook 5xx/timeout rate;
- acknowledgement latency or consumer receipt failures;
- migration version mismatch.

Every alert must link to the runbook and identify the consumer/subscription
scope. A dashboard must not use Realtime as the queue's source of truth.
