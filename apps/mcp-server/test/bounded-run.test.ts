import assert from "node:assert/strict";
import test from "node:test";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import {
  LifecycleToolRouter,
  MCP_TOOL_NAMES,
  toolDescriptor,
} from "../src/index.ts";
import type { ProducerServiceBoundary } from "../src/types.ts";

const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant_a",
  producer_id: "producer_a",
  allowed_stream_ids: ["stream.a"],
};

class FakeService implements ProducerServiceBoundary {
  readonly calls: Array<{ operation: string; runId?: string; value: unknown }> = [];

  async beginRun(value: unknown): Promise<unknown> {
    this.calls.push({ operation: "begin", value });
    return { run_id: "run_atomic_1", status: "running" };
  }

  async submitBatch(runId: string, value: unknown): Promise<unknown> {
    this.calls.push({ operation: "submit", runId, value });
    return { run_id: runId, status: "running" };
  }

  async completeRun(runId: string, value: unknown): Promise<unknown> {
    this.calls.push({ operation: "complete", runId, value });
    return { run_id: runId, status: "completed" };
  }
}

test("submit_bounded_run is published with server-managed downstream run_id", () => {
  assert.equal(MCP_TOOL_NAMES.includes("submit_bounded_run"), true);
  const descriptor = toolDescriptor("submit_bounded_run");
  const schema = descriptor.inputSchema;
  assert.deepEqual(schema.required, ["begin", "batches", "complete"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const batchItems = properties.batches.items as Record<string, unknown>;
  const batchProperties = batchItems.properties as Record<string, unknown>;
  const completeProperties = (properties.complete.properties ?? {}) as Record<string, unknown>;
  assert.equal(Object.hasOwn(batchProperties, "run_id"), false);
  assert.equal(Object.hasOwn(completeProperties, "run_id"), false);
  assert.equal((batchItems.required as unknown[]).includes("run_id"), false);
  assert.equal((properties.complete.required as unknown[]).includes("run_id"), false);
});

test("submit_bounded_run executes begin, batches, completion and injects returned run_id", async () => {
  const service = new FakeService();
  const router = new LifecycleToolRouter({ service, principal: PRINCIPAL });
  const result = await router.call("submit_bounded_run", {
    begin: {
      protocol_version: "0.1",
      idempotency_key: "begin-1",
      stream_id: "stream.a",
      producer: { producer_id: "producer_a", type: "chatgpt", name: "fixture", version: "1" },
      task: { task_type: "monitor", definition_id: null, definition_version: null },
      expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      started_at: "2026-08-25T00:00:00Z",
      parent_run_id: null,
      metadata: {},
    },
    batches: [
      { protocol_version: "0.1", batch_id: "b1", idempotency_key: "batch-1", sequence_number: 1, submitted_at: "2026-08-25T00:00:01Z", findings: [], evidence: [], metadata: {} },
      { protocol_version: "0.1", batch_id: "b2", idempotency_key: "batch-2", sequence_number: 2, submitted_at: "2026-08-25T00:00:02Z", findings: [], evidence: [], metadata: {} },
    ],
    complete: {
      protocol_version: "0.1",
      idempotency_key: "complete-1",
      status: "completed",
      completed_at: "2026-08-25T00:00:03Z",
      actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 2 },
      errors: [],
      metadata: {},
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(service.calls.map((call) => call.operation), ["begin", "submit", "submit", "complete"]);
  assert.deepEqual(service.calls.slice(1).map((call) => call.runId), ["run_atomic_1", "run_atomic_1", "run_atomic_1"]);
  for (const call of service.calls.slice(1)) {
    assert.equal((call.value as Record<string, unknown>).run_id, "run_atomic_1");
  }
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.run_id, "run_atomic_1");
  assert.equal(Array.isArray(structured.batches), true);
  assert.equal((structured.batches as unknown[]).length, 2);
});

test("submit_bounded_run rejects caller supplied downstream run_id", async () => {
  const service = new FakeService();
  const router = new LifecycleToolRouter({ service, principal: PRINCIPAL });
  const result = await router.call("submit_bounded_run", {
    begin: {},
    batches: [{ run_id: "caller-run" }],
    complete: {},
  });
  assert.equal(result.isError, true);
  assert.deepEqual(service.calls, []);
});
