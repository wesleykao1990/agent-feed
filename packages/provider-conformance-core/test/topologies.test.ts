import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { USAGE_METRICS, type UsageMetric } from "@agent-feed/assessment-core";
import { ChatGPTManualExportAdapter } from "@agent-feed/chatgpt-manual-export-adapter";
import { ClaudeHookAdapter } from "@agent-feed/claude-hook-adapter";
import { LocalFileRunBundleAdapter, type RunBundle } from "@agent-feed/local-file-adapter";
import { createLifecycleToolRouter } from "@agent-feed/mcp-server";
import { RestProducerAdapter, type RestProducerService } from "@agent-feed/rest-adapter";
import { buildProviderConformanceMatrix, type ProviderConformanceReceiptInput } from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PRINCIPAL = { tenant_id: "m11-tenant", producer_id: "m11-producer", allowed_stream_ids: ["m11-stream"] };

class RecordingService {
  readonly calls: string[] = [];
  async beginRunWithWireId(runId: string): Promise<unknown> { this.calls.push(`begin:${runId}`); return { run_id: runId, status: "running" }; }
  async beginRun(): Promise<unknown> { this.calls.push("begin:m11-mcp-run"); return { run_id: "m11-mcp-run", status: "running" }; }
  async submitBatch(runId: string): Promise<unknown> { this.calls.push(`batch:${runId}`); return { run_id: runId, status: "running" }; }
  async completeRun(runId: string): Promise<unknown> { this.calls.push(`complete:${runId}`); return { run_id: runId, status: "completed" }; }
}

function telemetry(observed?: UsageMetric, value = 0) {
  return USAGE_METRICS.map((metric) => metric === observed
    ? { metric, state: "observed" as const, value, provenance: "executor_measured" as const }
    : { metric, state: "unknown" as const, value: null, provenance: "unknown" as const });
}

function receipt(key: string, schedulerProvider: string, executorProvider: string, ingressKind: "manual_export" | "webhook" | "mcp" | "rest" | "local_file", adapterKey: string, invocation: string, observed?: UsageMetric, value = 0): ProviderConformanceReceiptInput {
  return {
    receiptKey: key,
    logicalJob: { jobKey: "m11-monitor", definitionVersion: 1, jobDefinitionHash: HASH, validationPolicyVersionId: "m11-policy-v1" },
    topology: {
      schedulerProvider, executorProvider, ingressKind,
      deploymentBindingHash: createHash("sha256").update(`${schedulerProvider}:${executorProvider}:${ingressKind}`).digest("hex"),
      capabilityProfileHashes: [createHash("sha256").update(`${executorProvider}:capabilities`).digest("hex")],
    },
    executionContext: {
      adapterKey, adapterVersion: "0.1.1",
      externalInvocationDigest: createHash("sha256").update(invocation).digest("hex"),
    },
    proofs: { occurrence: "satisfied", execution: "completed", assessment: "passed", delivery: "acknowledged" },
    telemetry: telemetry(observed, value),
  };
}

test("five existing ingress topologies exercise one comparable logical job", async () => {
  const chatgptService = new RecordingService();
  const chatgpt = new ChatGPTManualExportAdapter({
    service: chatgptService, principal: PRINCIPAL, direct_ingestion_capability: true,
    now: () => new Date("2026-08-20T00:00:01.000Z"),
  });
  const exported = await chatgpt.submit({
    response: "No changes found.", stream_id: "m11-stream", started_at: "2026-08-20T00:00:00.000Z",
    task: { task_type: "m11-monitor", definition_id: "m11-monitor", definition_version: "1" },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  });
  assert.deepEqual(chatgptService.calls, [`begin:${exported.bundle.run_id}`, `batch:${exported.bundle.run_id}`, `complete:${exported.bundle.run_id}`]);

  const claudeService = new RecordingService();
  const claude = new ClaudeHookAdapter({ service: claudeService, principal: PRINCIPAL });
  const claudeRun = "m11-claude-run";
  await claude.run([
    { type: "start", run_id: claudeRun, begin: {
      protocol_version: "0.1", idempotency_key: "m11-claude-begin", stream_id: "m11-stream",
      producer: { producer_id: "m11-producer", type: "claude", name: "claude", version: "1" },
      task: { task_type: "m11-monitor", definition_id: "m11-monitor", definition_version: "1" },
      expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      started_at: "2026-08-20T00:00:00.000Z", parent_run_id: null, metadata: {},
    } },
    { type: "batch", run_id: claudeRun, batch: {
      protocol_version: "0.1", run_id: claudeRun, batch_id: "m11-claude-batch", idempotency_key: "m11-claude-batch",
      sequence_number: 1, submitted_at: "2026-08-20T00:00:00.500Z", findings: [], evidence: [], metadata: {},
    } },
    { type: "complete", run_id: claudeRun, complete: {
      protocol_version: "0.1", run_id: claudeRun, idempotency_key: "m11-claude-complete", status: "completed",
      completed_at: "2026-08-20T00:00:01.000Z", actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 1 }, errors: [], metadata: {},
    } },
  ]);
  assert.deepEqual(claudeService.calls, [`begin:${claudeRun}`, `batch:${claudeRun}`, `complete:${claudeRun}`]);

  const mcpService = new RecordingService();
  const mcp = createLifecycleToolRouter({ service: mcpService, principal: PRINCIPAL });
  await mcp.call("begin_run", { protocol_version: "0.1", stream_id: "m11-stream" });
  await mcp.call("submit_batch", { protocol_version: "0.1", run_id: "m11-mcp-run" });
  await mcp.call("complete_run", { protocol_version: "0.1", run_id: "m11-mcp-run" });
  assert.deepEqual(mcpService.calls, ["begin:m11-mcp-run", "batch:m11-mcp-run", "complete:m11-mcp-run"]);

  const restService = new RecordingService();
  const rest = new RestProducerAdapter({
    service: Object.assign(restService, {
      security: { max_body_bytes: 1024 * 1024 },
      authenticate: () => PRINCIPAL,
      assertRateAllowed: () => ({ allowed: true, retry_after_seconds: null }),
      getRun: async () => ({ run_id: "m11-rest-run" }),
      getFindings: async () => [],
    }) as unknown as RestProducerService,
  });
  const restHeaders = { authorization: "Bearer fixture", "content-type": "application/json" };
  const restBegin = await rest.handle({ method: "POST", path: "/v1/runs:begin", headers: restHeaders, body: "{}" });
  assert.equal(restBegin.status, 201);
  await rest.handle({ method: "POST", path: "/v1/runs/m11-rest-run/batches", headers: restHeaders, body: "{}" });
  await rest.handle({ method: "POST", path: "/v1/runs/m11-rest-run:complete", headers: restHeaders, body: "{}" });
  assert.deepEqual(restService.calls, ["begin:m11-mcp-run", "batch:m11-rest-run", "complete:m11-rest-run"]);

  const localService = new RecordingService();
  const localRun = "m11-local-run";
  const local = new LocalFileRunBundleAdapter({ service: localService, principal: PRINCIPAL });
  const localBundle: RunBundle = {
    protocol_version: "0.1",
    run_id: localRun,
    begin: {
      protocol_version: "0.1", idempotency_key: "m11-local-begin", stream_id: "m11-stream",
      producer: { producer_id: "m11-producer", type: "automation", name: "local-runner", version: "1" },
      task: { task_type: "m11-monitor", definition_id: "m11-monitor", definition_version: "1" },
      expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      started_at: "2026-08-20T00:00:00.000Z", parent_run_id: null, metadata: {},
    },
    batches: [{
      protocol_version: "0.1", run_id: localRun, batch_id: "m11-local-batch", idempotency_key: "m11-local-batch",
      sequence_number: 1, submitted_at: "2026-08-20T00:00:00.500Z", findings: [], evidence: [{
        evidence_id: "m11-local-evidence", kind: "api",
        source: { uri: "https://example.invalid/m11-local", title: "M11 local fixture", publisher: null, source_id: "m11-local-source" },
        captured_at: "2026-08-20T00:00:00.500Z", published_at: null, locator: null,
        excerpt: "Synthetic non-sensitive M11 local fixture.", content_hash: null,
        artifact: { uri: null, media_type: null, size_bytes: null },
        handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false }, metadata: {},
      }], metadata: {},
    }],
    complete: {
      protocol_version: "0.1", run_id: localRun, idempotency_key: "m11-local-complete", status: "completed",
      completed_at: "2026-08-20T00:00:01.000Z", actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 0, evidence_submitted: 1, batches_submitted: 1 }, errors: [], metadata: {},
    },
  };
  await local.importJson(JSON.stringify(localBundle));
  assert.deepEqual(localService.calls, [`begin:${localRun}`, `batch:${localRun}`, `complete:${localRun}`]);

  const matrix = buildProviderConformanceMatrix([
    receipt("m11-chatgpt", "chatgpt-export-fixture", "chatgpt", "manual_export", "chatgpt-manual-export", exported.bundle.run_id),
    receipt("m11-claude", "claude-task-fixture", "claude", "webhook", "claude-hook", claudeRun),
    receipt("m11-mcp", "workflow-scheduler-fixture", "generic-mcp-agent", "mcp", "remote-mcp", "m11-mcp-run", "tool_calls", 3),
    receipt("m11-rest", "workflow-scheduler-fixture", "generic-rest-agent", "rest", "rest-adapter", "m11-rest-run", "wall_time_ms", 1000),
    receipt("m11-local", "local-offline-fixture", "local-runner", "local_file", "local-file", localRun),
  ]);
  assert.equal(matrix.topologyCount, 5);
  assert.equal(matrix.telemetryCoverage.tool_calls.observed, 1);
  assert.equal(matrix.telemetryCoverage.cost_microunits.unknown, 5);
  assert.equal(JSON.stringify(matrix).includes("No changes found"), false);
});
