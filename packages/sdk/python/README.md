# Python SDK

Planned public surfaces:

- producer client: `beginRun`, `submitBatch`, `completeRun`, and portable run-bundle export;
- consumer client: event signature verification, event parsing, acknowledgements, replay cursor, and dead-letter inspection;
- protocol types generated from all nine schemas at `agent_feed/generated/protocol.py` (run `python3 scripts/generate_protocol_types.py --check` to detect drift);
- idempotent retries and typed errors.

The SDK must not encode consumer-domain concepts such as reward rates, stock signals, jobs, or events.

The generated `TypedDict` fields preserve the protocol's wire snake_case.
Runtime validation still uses the JSON Schemas in `packages/schema/contracts`.
