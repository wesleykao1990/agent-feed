# Dead-letter inspection and replay

Status: **in progress — operator contract only**

Dead-letter state is durable delivery history, not a deletion queue. The
underlying Agent Feed event remains immutable and untrusted.

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

Replay is scoped to one authorized subscription. It keeps the original event ID
and immutable body, increments the delivery attempt/replay metadata, and
creates a new attempt record. It does not reset the event's creation time,
rewrite the finding, delete failures, or create a new domain finding.

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

The replay endpoint and persistence implementation are not yet present. Tests
required before operational use are listed in `docs/12_milestone_2_delivery.md`
and ADR-0003.
