# Dead-letter inspection and replay

Status: **M2 replay acceptance green; deployable replay endpoint remains future work**

Dead-letter state is durable delivery history, not a deletion queue. The
underlying Agent Feed event remains immutable and untrusted. Delivery-core
contains the state-machine and replay port shape, and the consumer service
contains scope/idempotency validation. A PostgreSQL repository and webhook
transport foundation now exist, and the combined live PostgreSQL suite passes
the persistence/replay paths. The worker process/CLI and deployable replay
endpoint/server remain future operational adapters.

## State model

```text
pending -> leased -> delivered
             |          |
             v          v
          retryable -> acknowledged
             |
             v
        dead_lettered -> replay_pending -> leased
```

An attempt may be retried after a transient failure or lease expiry. A
permanent/authentication/policy failure may move directly to dead letter
according to the configured policy. Prior attempts remain queryable.

## Inspection checklist

Before replay, an authorized operator confirms:

1. consumer and tenant scope;
2. immutable event ID and protocol version;
3. last error class and HTTP status, without exposing raw secrets;
4. attempt count, lease history, and prior replay count;
5. signing key ID and replay-window validity;
6. subscription filter and consumer endpoint;
7. hostile/security flags and any redistribution restriction;
8. reason for replay and expected remediation.

The operator records the decision and a bug/incident ID. A dead-letter event
must not be replayed merely to bypass authorization, security rejection, or a
consumer-domain review requirement.

## Replay semantics

Replay is scoped to one authorized subscription. It keeps the original event ID,
payload, occurred time, and payload hash, increments the delivery attempt, and
re-encodes/re-signs the protocol body with that required attempt field. It
creates a new attempt record without mutating the immutable source event. It
does not reset the event's creation time, rewrite the finding, delete failures,
or create a new domain finding.

Replay must be idempotent for the same operator command/idempotency key. A
second exact command returns the original replay receipt; changed replay
parameters under that key are conflicts.

## Safety limits

- enforce a bounded replay batch size;
- require explicit consumer scope;
- revalidate signing key and endpoint configuration;
- preserve at-least-once delivery and consumer event-ID dedupe;
- do not log raw payloads;
- stop replay if the consumer returns authentication/policy failures;
- monitor replay count and resulting backlog.

The transport-neutral API handler, PostgreSQL persistence implementation, and
pure replay contract are accepted by the M2 implementation gate. A deployable
replay endpoint and production worker transport wiring remain operational
follow-ups. Tests and scope rules are recorded in
`docs/12_milestone_2_delivery.md` and ADR-0003.
