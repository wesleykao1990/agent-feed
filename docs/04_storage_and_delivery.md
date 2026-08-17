# Storage and delivery

## Recommended production boundary

Agent Feed is a separate deployable service and owns its own database. Consumer applications communicate through versioned HTTPS/MCP contracts, never by querying Agent Feed tables.

For local development, both projects may run on one machine or one temporary Postgres instance, but integration tests must still use the public protocol boundary.

## Data model

Core tables:

- runs;
- batches;
- findings;
- submitted_evidence;
- finding_evidence;
- outbox_events;
- consumer_subscriptions;
- delivery_attempts;
- acknowledgements.

## Outbox and queue

The batch transaction writes findings/evidence and outbox events atomically. A queue worker delivers signed events to consumers. Failed delivery is retried and ultimately placed in a dead-letter state. External delivery is at-least-once. A 2xx response is acknowledged only after the consumer has durably recorded its idempotency receipt.

## Realtime

Realtime is optional for live admin screens such as “run in progress” or “five findings received.” It is never the durable delivery mechanism.
