import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  ProducerService,
  StaticProducerAuthenticator,
  type BeginRunRequest,
  type CompleteRunRequest,
  type ProducerPersistence,
  type ProducerPrincipal,
  type RunRecord,
  type SubmitBatchRequest,
} from "@agent-feed/producer-service";
import { createAgentFeedApiServer } from "../src/index.ts";

const PRINCIPAL: ProducerPrincipal = { tenant_id: "tenant_a", producer_id: "producer_a", allowed_stream_ids: ["stream.a"] };

const BEGIN = {
  protocol_version: "0.1",
  idempotency_key: "begin-idempotency-a",
  stream_id: "stream.a",
  producer: { producer_id: "producer_a", type: "automation", name: "fixture", version: "1" },
  task: { task_type: "monitor", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  started_at: "2026-08-18T00:00:00.000Z",
  parent_run_id: null,
  metadata: {},
};

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run_aaaaaaaa",
    tenant_id: "tenant_a",
    trace_id: "trace_aaaaaaaa",
    stream_id: "stream.a",
    producer_id: "producer_a",
    begin_idempotency_key: "begin-idempotency-a",
    begin_payload_hash: "hash",
    complete_idempotency_key: null,
    complete_payload_hash: null,
    status: "running",
    started_at: "2026-08-18T00:00:00.000Z",
    completed_at: null,
    envelope: {} as RunRecord["envelope"],
    batches: [],
    findings: [],
    evidence: [],
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    ...overrides,
  };
}

class FakePersistence implements ProducerPersistence {
  readonly runs = new Map<string, RunRecord>();
  async beginRun(input: BeginRunRequest): Promise<RunRecord> {
    const result = run({ tenant_id: input.tenant_id ?? "default", producer_id: input.producer.producer_id, stream_id: input.stream_id });
    this.runs.set(result.run_id, result);
    return result;
  }
  async submitBatch(input: SubmitBatchRequest): Promise<RunRecord> {
    const result = this.runs.get(input.run_id);
    if (!result) throw new Error("missing fixture run");
    return result;
  }
  async completeRun(input: CompleteRunRequest): Promise<RunRecord> {
    const result = this.runs.get(input.run_id);
    if (!result) throw new Error("missing fixture run");
    return result;
  }
  async getRunForTenant(tenantId: string, runId: string): Promise<RunRecord | null> {
    const result = this.runs.get(runId) ?? null;
    return result?.tenant_id === tenantId ? result : null;
  }
}

async function withServer<T>(callback: (baseUrl: string, persistence: FakePersistence) => Promise<T>): Promise<T> {
  const persistence = new FakePersistence();
  const service = new ProducerService({
    persistence,
    authenticator: new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["stream.a"] }]),
  });
  const server = createAgentFeedApiServer({ service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try { return await callback(`http://127.0.0.1:${address.port}`, persistence); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as unknown;
  return { status: response.status, body, headers: response.headers };
}

test("durable API exposes health/readiness and canonical producer lifecycle routes", async () => {
  await withServer(async (baseUrl, persistence) => {
    const health = await request(baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual((health.body as Record<string, unknown>).ok, true);

    const readiness = await request(baseUrl, "/ready");
    assert.equal(readiness.status, 200);
    assert.deepEqual((readiness.body as Record<string, unknown>).ok, true);

    const unauthorized = await request(baseUrl, "/v1/runs:begin", { method: "POST", body: JSON.stringify(BEGIN) });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

    const wrongMediaType = await request(baseUrl, "/v1/runs:begin", {
      method: "POST",
      headers: { authorization: "Bearer secret-a", "content-type": "text/plain" },
      body: JSON.stringify(BEGIN),
    });
    assert.equal(wrongMediaType.status, 415);
    assert.deepEqual(wrongMediaType.body, { error: "unsupported_media_type" });
    assert.equal(persistence.runs.size, 0);

    const created = await request(baseUrl, "/v1/runs:begin", {
      method: "POST",
      headers: { authorization: "Bearer secret-a", "content-type": "application/json" },
      body: JSON.stringify(BEGIN),
    });
    assert.equal(created.status, 201);
    assert.equal(persistence.runs.size, 1);

    const runId = (created.body as RunRecord).run_id;
    const fetched = await request(baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, { headers: { authorization: "Bearer secret-a" } });
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as RunRecord).run_id, runId);
    const findings = await request(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/findings`, { headers: { authorization: "Bearer secret-a" } });
    assert.equal(findings.status, 200);
    assert.deepEqual((findings.body as { run_id: string; findings: unknown[] }).findings, []);

    const camelCase = await request(baseUrl, "/v1/runs:begin", {
      method: "POST",
      headers: { authorization: "Bearer secret-a", "content-type": "application/json" },
      body: JSON.stringify({ ...BEGIN, streamId: BEGIN.stream_id }),
    });
    assert.equal(camelCase.status, 422);
    assert.deepEqual(camelCase.body, { error: "schema_validation_failed" });
  });
});

test("API maps route/body run mismatch and scoped reads deterministically", async () => {
  await withServer(async (baseUrl, persistence) => {
    persistence.runs.set("run_aaaaaaaa", run({ tenant_id: "tenant_b", producer_id: "producer_b", stream_id: "stream.b" }));
    const hidden = await request(baseUrl, "/v1/runs/run_aaaaaaaa", { headers: { authorization: "Bearer secret-a" } });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, { error: "run_not_found" });

    const mismatch = await request(baseUrl, "/v1/runs/run_aaaaaaaa/batches", {
      method: "POST",
      headers: { authorization: "Bearer secret-a", "content-type": "application/json" },
      body: JSON.stringify({
        protocol_version: "0.1",
        run_id: "run_bbbbbbbb",
        batch_id: "batch_001",
        idempotency_key: "batch-idempotency-a",
        sequence_number: 1,
        submitted_at: "2026-08-18T00:00:01.000Z",
        findings: [],
        evidence: [{
          evidence_id: "evidence_001", kind: "web",
          source: { uri: "https://example.invalid/source", title: null, publisher: null, source_id: null },
          captured_at: "2026-08-18T00:00:01.000Z", published_at: null, locator: null, excerpt: null,
          content_hash: null, artifact: { uri: null, media_type: null, size_bytes: null },
          handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false }, metadata: {},
        }],
        metadata: {},
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(mismatch.body, { error: "invalid_input" });
  });
});
