import assert from "node:assert/strict";
import test from "node:test";
import {
  ProducerService,
  StaticProducerAuthenticator,
  type BeginRunRequest,
  type CompleteRunRequest,
  type ProducerPersistence,
  type RunRecord,
  type SubmitBatchRequest,
} from "@agent-feed/producer-service";
import { RestProducerAdapter, handleRestRequest } from "../src/index.ts";

const PRINCIPAL = { tenant_id: "tenant_rest", producer_id: "producer_rest", allowed_stream_ids: ["rest.stream"] } as const;
const BEGIN = {
  protocol_version: "0.1",
  idempotency_key: "begin-rest-001",
  stream_id: "rest.stream",
  producer: { producer_id: "producer_rest", type: "automation", name: "rest-test", version: "1" },
  task: { task_type: "rest-test", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  started_at: "2026-08-18T00:00:00.000Z",
  parent_run_id: null,
  metadata: {},
};

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run_rest_001",
    tenant_id: PRINCIPAL.tenant_id,
    trace_id: "trace_rest_001",
    stream_id: "rest.stream",
    producer_id: PRINCIPAL.producer_id,
    begin_idempotency_key: "begin-rest-001",
    begin_payload_hash: "hash",
    complete_idempotency_key: null,
    complete_payload_hash: null,
    status: "running",
    started_at: BEGIN.started_at,
    completed_at: null,
    envelope: {} as RunRecord["envelope"],
    batches: [], findings: [], evidence: [],
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    ...overrides,
  };
}

class Persistence implements ProducerPersistence {
  readonly run = record();
  requestedRunId: string | undefined;
  async beginRun(_input: BeginRunRequest): Promise<RunRecord> { return this.run; }
  async submitBatch(_input: SubmitBatchRequest): Promise<RunRecord> { return this.run; }
  async completeRun(_input: CompleteRunRequest): Promise<RunRecord> { return this.run; }
  async getRunForTenant(_tenantId: string, runId: string): Promise<RunRecord | null> { this.requestedRunId = runId; return this.run; }
}

function service(): ProducerService {
  return new ProducerService({
    persistence: new Persistence(),
    authenticator: new StaticProducerAuthenticator([{ ...PRINCIPAL, secret: "rest-secret" }]),
    rate_limit: { max_requests_per_minute: 100, burst: 100 },
  });
}

test("REST transport and public service share authentication, path, and error mapping", async () => {
  const adapter = new RestProducerAdapter({ service: service() });
  const unauthorized = await adapter.handle({ method: "POST", path: "/v1/runs:begin", headers: { "content-type": "application/json" }, body: JSON.stringify(BEGIN) });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(unauthorized.body, { error: "unauthorized" });

  const created = await adapter.handle({
    method: "POST",
    path: "/v1/runs:begin",
    headers: { authorization: "Bearer rest-secret", "content-type": "application/json" },
    body: JSON.stringify(BEGIN),
  });
  assert.equal(created.status, 201);
  assert.equal((created.body as RunRecord).run_id, "run_rest_001");
});

test("REST rejects unsupported media, malformed UTF-8/JSON, and oversized bodies before lifecycle calls", async () => {
  const persistence = new Persistence();
  const configured = new ProducerService({
    persistence,
    authenticator: new StaticProducerAuthenticator([{ ...PRINCIPAL, secret: "rest-secret" }]),
  });
  const headers = { authorization: "Bearer rest-secret" };
  const media = await handleRestRequest({ method: "POST", path: "/v1/runs:begin", headers: { ...headers, "content-type": "text/plain" }, body: "{}" }, { service: configured });
  assert.equal(media.status, 415);
  const malformed = await handleRestRequest({ method: "POST", path: "/v1/runs:begin", headers: { ...headers, "content-type": "application/json" }, body: "{bad" }, { service: configured });
  assert.equal(malformed.status, 422);
  const oversized = await handleRestRequest({ method: "POST", path: "/v1/runs:begin", headers: { ...headers, "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) }, { service: configured });
  assert.equal(oversized.status, 413);
});

test("health is public but run reads remain scoped", async () => {
  const adapter = new RestProducerAdapter({ service: service() });
  const health = await adapter.handle({ method: "GET", path: "/health" });
  assert.equal(health.status, 200);
  assert.equal((health.body as { service: string }).service, "agent-feed-rest-adapter");
  const hidden = await adapter.handle({ method: "GET", path: "/v1/runs/run_rest_001" });
  assert.equal(hidden.status, 401);
});

test("class adapter preserves service_name and encoded slash wire IDs", async () => {
  const persistence = new Persistence();
  const configured = new ProducerService({
    persistence,
    authenticator: new StaticProducerAuthenticator([{ ...PRINCIPAL, secret: "rest-secret" }]),
  });
  const adapter = new RestProducerAdapter({ service: configured, service_name: "custom-rest" });
  const health = await adapter.handle({ method: "GET", path: "/health" });
  assert.equal((health.body as { service: string }).service, "custom-rest");
  const result = await adapter.handle({
    method: "GET",
    path: "/v1/runs/run%2Fwith%2Fslash",
    headers: { authorization: "Bearer rest-secret" },
  });
  assert.equal(result.status, 200);
  assert.equal(persistence.requestedRunId, "run/with/slash");
});
