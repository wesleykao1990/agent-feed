import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentFeedAbortError,
  AgentFeedApiError,
  AgentFeedTimeoutError,
  ConsumerClient,
  ProducerClient,
  type AgentFeedTransport,
  type AgentFeedTransportRequest,
  type AgentFeedTransportResponse,
} from "../src/index.ts";

function response(status: number, body: unknown, headers: Record<string, string> = {}): AgentFeedTransportResponse {
  return { status, body, headers };
}

class FakeTransport implements AgentFeedTransport {
  readonly requests: AgentFeedTransportRequest[] = [];
  readonly responses: Array<AgentFeedTransportResponse | Error> = [];

  async request(input: AgentFeedTransportRequest): Promise<AgentFeedTransportResponse> {
    this.requests.push(input);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("fake_response_missing");
    if (next instanceof Error) throw next;
    return next;
  }
}

const BEGIN = {
  protocol_version: "0.1" as const,
  idempotency_key: "begin-key",
  stream_id: "stream.a",
  producer: { producer_id: "producer.a", type: "automation" as const, name: "fixture", version: "1" },
  task: { task_type: "monitor", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  started_at: "2026-08-18T00:00:00.000Z",
  parent_run_id: null,
  metadata: {},
};

test("producer lifecycle uses exact routes, generated wire bodies, and idempotent retry", async () => {
  const transport = new FakeTransport();
  transport.responses.push(
    response(503, { error: "storage_error" }, { "retry-after": "0" }),
    response(201, { run_id: "run/a", status: "running" }),
    response(202, { run_id: "run/a", status: "running" }),
    response(200, { run_id: "run/a", status: "completed" }),
    response(200, { run_id: "run/a", findings: [] }),
  );
  const client = new ProducerClient({
    base_url: "https://feed.example.test/agent-feed",
    token: "secret-token",
    transport,
    retry: { max_attempts: 2 },
    sleep: async () => {},
  });

  const begun = await client.beginRun(BEGIN);
  assert.equal(begun.run_id, "run/a");
  const batch = {
    protocol_version: "0.1" as const,
    run_id: "run/a",
    batch_id: "batch-1",
    idempotency_key: "batch-key",
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [],
    evidence: [],
    metadata: {},
  };
  await client.submitBatch("run/a", batch);
  await client.completeRun("run/a", {
    protocol_version: "0.1",
    run_id: "run/a",
    idempotency_key: "complete-key",
    status: "completed",
    completed_at: "2026-08-18T00:00:02.000Z",
    actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 1 },
    errors: [],
    metadata: {},
  });
  await client.getFindings("run/a");

  assert.equal(transport.requests.length, 5, "one transient response is retried");
  assert.equal(transport.requests[0]?.url, "https://feed.example.test/agent-feed/v1/runs:begin");
  assert.equal(transport.requests[2]?.url, "https://feed.example.test/agent-feed/v1/runs/run%2Fa/batches");
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer secret-token");
  assert.equal(JSON.parse(transport.requests[2]?.body ?? "{}").idempotency_key, "batch-key");
});

test("consumer pull, acknowledgement, and replay preserve opaque cursor and use keyed retries", async () => {
  const transport = new FakeTransport();
  transport.responses.push(
    response(200, { items: [], nextCursor: "opaque%2Fcursor", ackCursor: null, hasMore: false }),
    response(200, { acknowledgementId: "ack-1", acknowledgedDeliveryIds: ["delivery-1"], ackCursor: "opaque" }),
    response(200, { replayId: "replay-1", delivery: { deliveryId: "delivery-1" } }),
  );
  const client = new ConsumerClient({
    baseUrl: "https://feed.example.test",
    credential: "opaque-credential",
    consumerId: "consumer/a",
    transport,
    sleep: async () => {},
  });
  const page = await client.pull("subscription/a", { limit: 10 });
  assert.equal(page.nextCursor, "opaque%2Fcursor");
  await client.ack("subscription/a", ["delivery-1"], { idempotencyKey: "ack-key" });
  await client.replay("subscription/a", "delivery-1", { idempotency_key: "replay-key" });

  assert.equal(transport.requests[0]?.url, "https://feed.example.test/v1/consumers/consumer%2Fa/events?subscription_id=subscription%2Fa&limit=10");
  assert.equal(transport.requests[1]?.method, "POST");
  assert.equal(JSON.parse(transport.requests[1]?.body ?? "{}").idempotencyKey, "ack-key");
  assert.equal(transport.requests[2]?.url, "https://feed.example.test/v1/consumers/consumer%2Fa/dead-letters/delivery-1:replay?subscription_id=subscription%2Fa");
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer opaque-credential");
});

test("unsafe consumer mutations are not retried and API diagnostics are redacted", async () => {
  const transport = new FakeTransport();
  transport.responses.push(response(503, { error: "storage_error", secret: "do-not-expose" }));
  const client = new ConsumerClient({
    base_url: "https://feed.example.test",
    transport,
    sleep: async () => {},
  });
  await assert.rejects(
    client.createSubscription({ name: "fixture", selectors: { streamIds: ["stream.a"] }, delivery: { mode: "pull" } }),
    (error: unknown) => error instanceof AgentFeedApiError && error.code === "storage_error" && !error.message.includes("do-not-expose"),
  );
  assert.equal(transport.requests.length, 1);
});

test("timeout and caller abort are typed and preserve no underlying exception text", async () => {
  const timeoutTransport: AgentFeedTransport = {
    request: async ({ signal }) => new Promise<AgentFeedTransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("credential=super-secret")), { once: true });
    }),
  };
  const timeoutClient = new ProducerClient({ base_url: "https://feed.example.test", transport: timeoutTransport, timeout_ms: 5, retry: { max_attempts: 1 } });
  await assert.rejects(timeoutClient.getRun("run-1"), (error: unknown) => error instanceof AgentFeedTimeoutError && !error.message.includes("super-secret"));

  const controller = new AbortController();
  controller.abort();
  const abortClient = new ProducerClient({ base_url: "https://feed.example.test", transport: timeoutTransport });
  await assert.rejects(abortClient.getRun("run-1", { signal: controller.signal }), (error: unknown) => error instanceof AgentFeedAbortError);

  const lateTransport: AgentFeedTransport = {
    request: async () => new Promise<AgentFeedTransportResponse>((resolve) => {
      setTimeout(() => resolve(response(200, { run_id: "run-late" })), 20);
    }),
  };
  const lateClient = new ProducerClient({ base_url: "https://feed.example.test", transport: lateTransport, timeout_ms: 5, retry: { max_attempts: 1 } });
  await assert.rejects(lateClient.getRun("run-1"), (error: unknown) => error instanceof AgentFeedTimeoutError);
});
