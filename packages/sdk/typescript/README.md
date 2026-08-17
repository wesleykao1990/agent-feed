# Typescript SDK

Planned public surfaces:

- producer client: `beginRun`, `submitBatch`, `completeRun`, and portable run-bundle export;
- consumer client: event signature verification, event parsing, acknowledgements, replay cursor, and dead-letter inspection;
- schema validation generated from `packages/schema/contracts`;
- idempotent retries and typed errors.

The SDK must not encode consumer-domain concepts such as reward rates, stock signals, jobs, or events.
