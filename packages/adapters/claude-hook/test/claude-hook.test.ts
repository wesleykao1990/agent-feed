import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeHookAdapter, ClaudeHookAdapterError, ClaudeHookImportFailure } from "../src/index.ts";
import type { ProducerLifecycleService } from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

const PRINCIPAL: ProducerPrincipal = { tenant_id: "tenant_claude", producer_id: "producer_claude", allowed_stream_ids: ["claude.stream"] };
const RUN_ID = "run_claude_001";
const BEGIN = {
  protocol_version: "0.1", idempotency_key: "begin-claude-001", stream_id: "claude.stream",
  producer: { producer_id: "producer_claude", type: "claude", name: "claude-hook", version: "1" },
  task: { task_type: "claude-hook", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} }, started_at: "2026-08-18T00:00:00.000Z", parent_run_id: null, metadata: {},
};
const COMPLETE = {
  protocol_version: "0.1", run_id: RUN_ID, idempotency_key: "complete-claude-001", status: "completed", completed_at: "2026-08-18T00:00:01.000Z",
  actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} }, stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 }, errors: [], metadata: {},
};

class Service implements ProducerLifecycleService {
  readonly calls: string[] = [];
  async beginRunWithWireId(runId: string): Promise<unknown> { this.calls.push(`begin:${runId}`); return { run_id: runId, status: "running" }; }
  async submitBatch(runId: string): Promise<unknown> { this.calls.push(`batch:${runId}`); return { run_id: runId, status: "running" }; }
  async completeRun(runId: string): Promise<unknown> { this.calls.push(`complete:${runId}`); return { run_id: runId, status: "completed" }; }
}

test("maps Claude hook lifecycle aliases to the shared producer service", async () => {
  const service = new Service();
  const adapter = new ClaudeHookAdapter({ service, principal: PRINCIPAL });
  const results = await adapter.run([
    { type: "start", run_id: RUN_ID, begin: BEGIN },
    { type: "batch", run_id: RUN_ID, batch: {
      protocol_version: "0.1", run_id: RUN_ID, batch_id: "batch-claude-001", idempotency_key: "batch-claude-001", sequence_number: 1, submitted_at: "2026-08-18T00:00:00.500Z", findings: [], evidence: [{
        evidence_id: "evidence-claude-001", kind: "other", source: { uri: "urn:claude:source", title: null, publisher: null, source_id: null }, captured_at: "2026-08-18T00:00:00.500Z", published_at: null, locator: null, excerpt: "untrusted", content_hash: null, artifact: { uri: null, media_type: null, size_bytes: null }, handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false }, metadata: {},
      }], metadata: {},
    } },
    { type: "complete", run_id: RUN_ID, complete: COMPLETE },
  ]);
  assert.deepEqual(service.calls, [`begin:${RUN_ID}`, `batch:${RUN_ID}`, `complete:${RUN_ID}`]);
  assert.equal(results[2]?.type, "run.completed");
});

test("closes failed batch as partial without leaking hook errors", async () => {
  const service = new Service();
  service.submitBatch = async (runId: string) => { service.calls.push(`batch:${runId}`); throw new Error("Bearer hook-secret must not leak"); };
  service.completeRun = async (runId: string) => { service.calls.push(`complete:${runId}`); return { run_id: runId, status: "partial" }; };
  const adapter = new ClaudeHookAdapter({ service, principal: PRINCIPAL, now: () => new Date("2026-08-18T00:00:02.000Z") });
  await adapter.handle({ type: "run.started", run_id: RUN_ID, begin: BEGIN });
  const result = await adapter.handle({ type: "run.batch", run_id: RUN_ID, batch: { ...COMPLETE, batch_id: "batch-001" } });
  assert.equal(result.type, "run.partial");
  assert.equal(result.recovery?.status, "closed");
  assert.equal(JSON.stringify(result).includes("hook-secret"), false);
  assert.deepEqual(service.calls, [`begin:${RUN_ID}`, `batch:${RUN_ID}`, `complete:${RUN_ID}`]);
});

test("returns resumable recovery when closure is unavailable", async () => {
  const service = new Service();
  service.submitBatch = async (runId: string) => { service.calls.push(`batch:${runId}`); throw new Error("database secret"); };
  service.completeRun = async (runId: string) => { service.calls.push(`complete:${runId}`); throw new Error("unreachable"); };
  const adapter = new ClaudeHookAdapter({ service, principal: PRINCIPAL });
  await adapter.handle({ type: "run.started", run_id: RUN_ID, begin: BEGIN });
  await assert.rejects(
    adapter.handle({ type: "batch", run_id: RUN_ID, batch: { ...COMPLETE, batch_id: "batch-001" } }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeHookImportFailure);
      assert.equal(error.recovery.run_id, RUN_ID);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(Object.keys(error).includes("recovery"), false);
      assert.equal(JSON.stringify(error).includes('"bundle"'), false);
      return true;
    },
  );
});

test("preserves an uncertain begin outcome as resumable recovery", async () => {
  const service = new Service();
  service.beginRunWithWireId = async () => { throw Object.assign(new Error("timeout"), { code: "storage_error" }); };
  let persisted: unknown;
  const adapter = new ClaudeHookAdapter({
    service,
    principal: PRINCIPAL,
    recovery_store: { persist: async (artifact) => { persisted = artifact; } },
  });
  await assert.rejects(
    adapter.handle({ type: "run.started", run_id: RUN_ID, begin: BEGIN }),
    (error: unknown) => error instanceof ClaudeHookImportFailure
      && error.recovery.failure.phase === "begin"
      && error.details.recovery_status === "resumable",
  );
  assert.equal((persisted as { failure: { phase: string } }).failure.phase, "begin");
});

test("rejects undefined hook events with a stable input error", async () => {
  const adapter = new ClaudeHookAdapter({ service: new Service(), principal: PRINCIPAL });
  await assert.rejects(
    adapter.handle(undefined),
    (error: unknown) => error instanceof ClaudeHookAdapterError && error.code === "invalid_event",
  );
});
