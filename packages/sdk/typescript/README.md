# Agent Feed TypeScript SDK

`@agent-feed/sdk@0.1.1` is a small ESM client for protocol `0.1`. It contains
no server, database, consumer-domain, or persistence implementation. The npm
artifact contains compiled ESM JavaScript and declarations under `dist/`, so
normal Node consumers do not need TypeScript's strip-types mode. The generated
wire types remain the source of truth for producer requests and protocol
events.

## Install and construct a client

```sh
npm install @agent-feed/sdk@0.1.1
```

The default transport uses `fetch` (Node 22, browsers, or a compatible
runtime). For tests, a proxy, or another HTTP implementation, inject a
transport implementing `AgentFeedTransport`.

```ts
import { ProducerClient } from "@agent-feed/sdk";

const producer = new ProducerClient({
  base_url: "https://feed.example.test",
  token: process.env.AGENT_FEED_TOKEN,
});
```

`baseUrl`, `timeoutMs`, and `consumerId` camelCase aliases are accepted for
application code that follows JavaScript naming conventions. Protocol request
fields remain wire-compatible snake_case.

## Producer lifecycle

```ts
import type {
  BeginRunRequest,
  CompleteRunRequest,
  SubmitBatchRequest,
} from "@agent-feed/sdk";

const begin: BeginRunRequest = {
  protocol_version: "0.1",
  idempotency_key: "begin-2026-08-18-001",
  stream_id: "monitor.example",
  producer: { producer_id: "worker-1", type: "automation", name: "monitor", version: "1" },
  task: { task_type: "monitor", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  started_at: new Date().toISOString(),
  parent_run_id: null,
  metadata: {},
};

const run = await producer.beginRun(begin);
const runId = run.run_id;

const batch: SubmitBatchRequest = {
  protocol_version: "0.1",
  run_id: runId,
  batch_id: "batch-001",
  idempotency_key: "batch-2026-08-18-001",
  sequence_number: 1,
  submitted_at: new Date().toISOString(),
  findings: [],
  evidence: [],
  metadata: {},
};
await producer.submitBatch(runId, batch);

const complete: CompleteRunRequest = {
  protocol_version: "0.1",
  run_id: runId,
  idempotency_key: "complete-2026-08-18-001",
  status: "completed",
  completed_at: new Date().toISOString(),
  actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  stats: {
    sources_attempted: 0,
    sources_succeeded: 0,
    findings_submitted: 0,
    evidence_submitted: 0,
    batches_submitted: 1,
  },
  errors: [],
  metadata: {},
};
await producer.completeRun(runId, complete);
const current = await producer.getRun(runId);
const findings = await producer.getFindings(runId);
```

`createRunBundle` and `producer.buildRunBundle` create a schema-typed,
portable bundle for an agent that cannot call the network.

## Large result sets

`submitLargeRun` accepts a synchronous or asynchronous stream of atomic units,
plans protocol-valid requests under the deployment's 1 MiB, 100-finding, and
100-evidence defaults, and submits one batch at a time. It does not complete
the run. The caller must send `completeRun` only after every planned batch has
been durably accepted.

```ts
const summary = await producer.submitLargeRun(runId, sourceFamilyUnits(), {
  // Keep this fixed when regenerating a stopped plan.
  submitted_at: "2026-08-21T03:00:00.000Z",
  on_batch_accepted: async ({ batch, batches_submitted }) => {
    await saveCheckpoint({
      sequence_number: batch.sequence_number,
      batches_submitted,
    });
  },
});
```

Each `LargeRunUnit` contains `findings` and `evidence` arrays and is never split
across requests. A finding may reference evidence introduced by the same unit
or by an earlier unit; forward and missing references fail before submission.
Batch IDs and idempotency keys are derived from canonical content, so replaying
the same ordered units with the same options produces byte-equal exact retries.
The planner rejects a unit that cannot fit by itself instead of raising server
limits or silently separating a finding from its new evidence.

`planLargeRunBatches` exposes the async batch stream when callers need to store
or inspect the plan before transport. Input order is part of batch identity.
Changing order, metadata, limits, timestamps, or content creates a new plan and
must not reuse an earlier checkpoint.

## Consumer pull, acknowledgement, and replay

Consumer routes follow the delivery API design in
`docs/operations/delivery-api.md`. Set `consumer_id` when the deployment uses
the documented `/v1/consumers/{consumer_id}` path, or set `consumer_prefix`
for a gateway-specific route. The credential is opaque to the SDK and is sent
as a bearer token only; scope must still be resolved by the server.

```ts
import { ConsumerClient } from "@agent-feed/sdk";

const consumer = new ConsumerClient({
  base_url: "https://feed.example.test",
  token: process.env.AGENT_FEED_CONSUMER_TOKEN,
  consumer_id: "optimizer-1",
});

const page = await consumer.pullPage("subscription-1", { limit: 50 });
if (page.items.length > 0) {
  const receipt = await consumer.acknowledge(
    "subscription-1",
    page.items.map((item) => item.deliveryId),
    { idempotency_key: "ack-2026-08-18-001", ack_through_cursor: page.ackCursor ?? undefined },
  );
  void receipt;
}

await consumer.replayDeadLetter("subscription-1", "delivery-1", {
  idempotency_key: "replay-2026-08-18-001",
});
```

`pull`, `ack`, and `replay` are aliases for the longer method names. Cursor
values are opaque and are never decoded or logged. Subscription lifecycle and
dead-letter inspection are also available through `createSubscription`,
`updateSubscription`, `listSubscriptions`, and `listDeadLetters`.

## Transport, timeout, retry, and errors

Every operation accepts `{ signal, timeout_ms, retry }`. A timeout applies per
attempt. An external `AbortSignal` is never retried. The default policy is
three total attempts with bounded exponential backoff. GETs may retry on
transient transport/HTTP failures. A mutation may retry only when its body
contains a non-empty `idempotency_key` or `idempotencyKey`; create/update
subscription calls therefore do not retry automatically.

```ts
const controller = new AbortController();
const page = await consumer.pullPage("subscription-1", {
  signal: controller.signal,
  timeout_ms: 5_000,
  retry: { max_attempts: 2 },
});
```

Errors are typed as `AgentFeedApiError`, `AgentFeedTimeoutError`,
`AgentFeedAbortError`, `AgentFeedTransportError`, or
`AgentFeedResponseError` (all extend `AgentFeedError`). API error codes are
available as `error.code`; diagnostics deliberately exclude URLs, headers,
request bodies, response bodies, cursors, credentials, and underlying
exception text. `error.toJSON()` is safe for structured application logs.

Run `npm run build` to emit the clean `dist/` ESM/declaration artifact and
`npm test` for the transport/client tests and packed-package smoke. The smoke
packs the artifact, installs it into a temporary external consumer, and imports
it with ordinary Node (without strip-types). `npm run verify` runs the clean
build and complete test set.
Run `python3 scripts/generate_protocol_types.py --check` from the repository
root to detect generated protocol drift.
