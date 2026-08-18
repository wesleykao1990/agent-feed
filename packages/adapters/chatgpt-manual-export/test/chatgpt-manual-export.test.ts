import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatGPTManualExportAdapter,
  ChatGPTManualExportError,
  ChatGPTManualImportFailure,
  type ChatGPTManualExportInput,
} from "../src/index.ts";
import type { ProducerLifecycleService } from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

const PRINCIPAL: ProducerPrincipal = { tenant_id: "tenant_chatgpt", producer_id: "producer_chatgpt", allowed_stream_ids: ["chatgpt.stream"] };

class Service implements ProducerLifecycleService {
  readonly calls: string[] = [];
  async beginRunWithWireId(runId: string): Promise<unknown> { this.calls.push(`begin:${runId}`); return { run_id: runId }; }
  async submitBatch(runId: string): Promise<unknown> { this.calls.push(`batch:${runId}`); return { run_id: runId }; }
  async completeRun(runId: string): Promise<unknown> { this.calls.push(`complete:${runId}`); return { run_id: runId, status: "completed" }; }
}

class FailingBatchService extends Service {
  override async submitBatch(runId: string): Promise<unknown> {
    this.calls.push(`batch:${runId}`);
    throw Object.assign(new Error("Authorization Bearer export-secret"), { code: "storage_error" });
  }
}

function input(response: string): ChatGPTManualExportInput {
  return { response, stream_id: "chatgpt.stream", task: { task_type: "monitor", definition_id: null, definition_version: null }, expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} }, started_at: "2026-08-18T00:00:00.000Z" };
}

test("tool-less export is a protocol-valid, stable run bundle", async () => {
  const adapter = new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:01.000Z") });
  const first = await adapter.export(input("No changes found."));
  const second = await adapter.export(input("No changes found."));
  assert.deepEqual(second.bundle, first.bundle);
  assert.equal(first.direct_ingestion_available, false);
  assert.equal((first.bundle.begin.producer as { type: string }).type, "chatgpt");
  assert.equal(first.bundle.batches.length, 1);
  assert.equal(first.bundle.complete.status, "completed");
});

test("capability absent fails closed for submit and never calls a service", async () => {
  const service = new Service();
  const adapter = new ChatGPTManualExportAdapter({ service, principal: PRINCIPAL });
  await assert.rejects(adapter.submit(input("response")), (error: unknown) => error instanceof ChatGPTManualExportError && error.code === "capability_unavailable");
  assert.deepEqual(service.calls, []);
});

test("capability present submits the same bundle through local-file lifecycle", async () => {
  const service = new Service();
  const adapter = new ChatGPTManualExportAdapter({ service, principal: PRINCIPAL, direct_ingestion_capability: true, now: () => new Date("2026-08-18T00:00:01.000Z") });
  const result = await adapter.submit(input("response"));
  assert.equal(result.direct_ingestion_available, true);
  assert.equal(result.imported.complete !== undefined, true);
  assert.deepEqual(service.calls, [`begin:${result.bundle.run_id}`, `batch:${result.bundle.run_id}`, `complete:${result.bundle.run_id}`]);
});

test("derives identity keys from context and occurrence time, not response text alone", async () => {
  const adapter = new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:01.000Z") });
  const first = await adapter.export(input("same response"));
  const otherContext = await adapter.export({ ...input("same response"), stream_id: "other.stream" });
  assert.notEqual(otherContext.bundle.run_id, first.bundle.run_id);
  assert.notEqual(otherContext.bundle.begin.idempotency_key, first.bundle.begin.idempotency_key);

  const firstOccurrence = await new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:01.000Z") }).export({ response: "same response", stream_id: "chatgpt.stream" });
  const secondOccurrence = await new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:02.000Z") }).export({ response: "same response", stream_id: "chatgpt.stream" });
  assert.notEqual(secondOccurrence.bundle.run_id, firstOccurrence.bundle.run_id);

  const pinned = { response: "same response", stream_id: "chatgpt.stream", started_at: "2026-08-18T00:00:00.000Z" };
  const retryOne = await new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:01.000Z") }).export(pinned);
  const retryTwo = await new ChatGPTManualExportAdapter({ now: () => new Date("2026-08-19T00:00:01.000Z") }).export(pinned);
  assert.deepEqual(retryTwo.bundle, retryOne.bundle);
});

test("keeps ChatGPT recovery explicit but serialization-safe", async () => {
  const service = new FailingBatchService();
  const adapter = new ChatGPTManualExportAdapter({
    service,
    principal: PRINCIPAL,
    direct_ingestion_capability: true,
    now: () => new Date("2026-08-18T00:00:01.000Z"),
  });
  await assert.rejects(
    adapter.submit(input("response")),
    (error: unknown) => {
      assert.ok(error instanceof ChatGPTManualImportFailure);
      assert.equal(error.recovery.run_id, error.details.run_id ?? error.recovery.run_id);
      assert.equal(Object.keys(error).includes("recovery"), false);
      assert.equal(JSON.stringify(error).includes('"bundle"'), false);
      assert.equal(error.message.includes("export-secret"), false);
      return true;
    },
  );
});

test("existing JSON bundles are validated and credential-like text is rejected without leaking it", async () => {
  const adapter = new ChatGPTManualExportAdapter();
  await assert.rejects(adapter.export(input(JSON.stringify({ protocol_version: "0.1", run_id: "too-short", begin: {}, batches: [], complete: {} }))), (error: unknown) => error instanceof ChatGPTManualExportError && error.code === "bundle_invalid");
  await assert.rejects(adapter.export(input("token=super-secret-value")), (error: unknown) => error instanceof ChatGPTManualExportError && error.code === "secret_detected" && error.message.includes("super-secret") === false);
});
