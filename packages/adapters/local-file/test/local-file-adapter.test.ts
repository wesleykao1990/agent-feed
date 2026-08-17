import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LocalFileAdapterError,
  LocalFileRunBundleAdapter,
  type ProducerLifecycleService,
  type RunBundle,
} from "../src/index.ts";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "local-file-tenant",
  producer_id: "local-file-producer",
  allowed_stream_ids: ["local.file.stream"],
};

const RUN_ID = "run_non_uuid_wire_id_001";

function bundle(): RunBundle {
  return {
    protocol_version: "0.1",
    run_id: RUN_ID,
    begin: {
      protocol_version: "0.1",
      idempotency_key: "begin-local-file-001",
      stream_id: "local.file.stream",
      producer: {
        producer_id: "local-file-producer",
        type: "automation",
        name: "local-file-test",
        version: "1",
      },
      task: {
        task_type: "local-file-test",
        definition_id: null,
        definition_version: null,
      },
      expected_scope: {
        source_ids: ["source-local"],
        subjects: ["subject-local"],
        queries: [],
        metadata: {},
      },
      started_at: "2026-08-18T00:00:00.000Z",
      parent_run_id: null,
      metadata: {},
    },
    batches: [
      {
        protocol_version: "0.1",
        run_id: RUN_ID,
        batch_id: "batch-local-001",
        idempotency_key: "batch-local-file-001",
        sequence_number: 1,
        submitted_at: "2026-08-18T00:00:01.000Z",
        findings: [],
        evidence: [
          {
            evidence_id: "evidence-local-001",
            kind: "api",
            source: {
              uri: "https://example.invalid/local-file",
              title: "Local file fixture",
              publisher: null,
              source_id: "source-local",
            },
            captured_at: "2026-08-18T00:00:01.000Z",
            published_at: null,
            locator: null,
            excerpt: "A non-sensitive local-file fixture.",
            content_hash: null,
            artifact: {
              uri: null,
              media_type: null,
              size_bytes: null,
            },
            handling: {
              contains_personal_data: false,
              contains_secrets: false,
              redistribution_restricted: false,
            },
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    complete: {
      protocol_version: "0.1",
      run_id: RUN_ID,
      idempotency_key: "complete-local-file-001",
      status: "completed",
      completed_at: "2026-08-18T00:00:02.000Z",
      actual_scope: {
        source_ids: ["source-local"],
        subjects: ["subject-local"],
        queries: [],
        metadata: {},
      },
      stats: {
        sources_attempted: 1,
        sources_succeeded: 1,
        findings_submitted: 0,
        evidence_submitted: 1,
        batches_submitted: 1,
      },
      errors: [],
      metadata: {},
    },
  };
}

class DurableReceiptSpy implements ProducerLifecycleService {
  readonly calls: string[] = [];
  readonly arguments: Array<{ method: string; runId?: string; value?: unknown }> = [];
  readonly writes: string[] = [];
  readonly #receipts = new Map<string, unknown>();

  private receipt(key: string, value: unknown): unknown {
    const existing = this.#receipts.get(key);
    if (existing !== undefined) return existing;
    this.#receipts.set(key, value);
    this.writes.push(key);
    return value;
  }

  async beginRunWithWireId(wireRunId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    assert.equal(principal, PRINCIPAL);
    this.calls.push("beginRunWithWireId");
    this.arguments.push({ method: "beginRunWithWireId", runId: wireRunId, value });
    return this.receipt("begin", { run_id: wireRunId, status: "running" });
  }

  async submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    assert.equal(principal, PRINCIPAL);
    this.calls.push("submitBatch");
    this.arguments.push({ method: "submitBatch", runId, value });
    return this.receipt("batch", { run_id: runId, status: "running", batch_accepted: true });
  }

  async completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    assert.equal(principal, PRINCIPAL);
    this.calls.push("completeRun");
    this.arguments.push({ method: "completeRun", runId, value });
    return this.receipt("complete", { run_id: runId, status: "completed" });
  }
}

function makeAdapter(service = new DurableReceiptSpy()): { adapter: LocalFileRunBundleAdapter; service: DurableReceiptSpy } {
  return {
    adapter: new LocalFileRunBundleAdapter({ service, principal: PRINCIPAL }),
    service,
  };
}

test("validates a run bundle before any durable lifecycle call", async () => {
  const { adapter, service } = makeAdapter();
  const invalid = bundle() as unknown as Record<string, unknown>;
  invalid.protocol_version = "0.2";

  await assert.rejects(
    adapter.importJson(JSON.stringify(invalid)),
    (error: unknown) => error instanceof LocalFileAdapterError && error.code === "bundle_schema_validation_failed",
  );
  assert.deepEqual(service.calls, []);
});

test("calls begin, batches in order, then complete while preserving a non-UUID wire run ID", async () => {
  const { adapter, service } = makeAdapter();
  const result = await adapter.importJson(JSON.stringify(bundle()));

  assert.deepEqual(service.calls, ["beginRunWithWireId", "submitBatch", "completeRun"]);
  assert.equal(service.arguments[0]?.runId, RUN_ID);
  assert.equal(service.arguments[1]?.runId, RUN_ID);
  assert.equal(service.arguments[2]?.runId, RUN_ID);
  assert.equal((result.run as { run_id: string }).run_id, RUN_ID);
});

test("delegates exact retries to durable service receipts without creating duplicate writes", async () => {
  const { adapter, service } = makeAdapter();
  const payload = JSON.stringify(bundle());
  const first = await adapter.importJson(payload);
  const second = await adapter.importJson(payload);

  assert.deepEqual(second, first);
  assert.deepEqual(service.writes, ["begin", "batch", "complete"]);
  assert.deepEqual(service.calls, [
    "beginRunWithWireId",
    "submitBatch",
    "completeRun",
    "beginRunWithWireId",
    "submitBatch",
    "completeRun",
  ]);
});

test("rejects a batch whose wire run ID differs before calling the producer service", async () => {
  const { adapter, service } = makeAdapter();
  const invalid = bundle();
  invalid.batches[0]!.run_id = "run_other_wire_id_001";

  await assert.rejects(
    adapter.importJson(JSON.stringify(invalid)),
    (error: unknown) => error instanceof LocalFileAdapterError && error.code === "batch_run_id_mismatch",
  );
  assert.deepEqual(service.calls, []);
});

test("reads a local JSON file through the same validated import path", async () => {
  const { adapter } = makeAdapter();
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-feed-local-file-"));
  const filename = path.join(directory, "bundle.json");
  try {
    await writeFile(filename, JSON.stringify(bundle()), "utf8");
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), bundle());
    const result = await adapter.importFile(filename);
    assert.equal((result.complete as { run_id: string }).run_id, RUN_ID);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed JSON without invoking the service", async () => {
  const { adapter, service } = makeAdapter();
  await assert.rejects(
    adapter.importJson("{not-json"),
    (error: unknown) => error instanceof LocalFileAdapterError && error.code === "invalid_json",
  );
  assert.deepEqual(service.calls, []);
});
