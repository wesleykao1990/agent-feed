import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  GenericWebhookAdapterError,
  GenericWebhookInputAdapter,
  GenericWebhookImportFailure,
  type GenericWebhookMapper,
} from "../src/index.ts";
import type { ProducerLifecycleService, RunBundle } from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

const PRINCIPAL: ProducerPrincipal = { tenant_id: "tenant_webhook", producer_id: "producer_webhook", allowed_stream_ids: ["webhook.stream"] };
const SECRET = "webhook-secret-001";
const RUN_ID = "run_webhook_001";

function bundle(): RunBundle {
  return {
    protocol_version: "0.1",
    run_id: RUN_ID,
    begin: {
      protocol_version: "0.1", idempotency_key: "begin-webhook-001", stream_id: "webhook.stream",
      producer: { producer_id: "producer_webhook", type: "automation", name: "webhook", version: "1" },
      task: { task_type: "webhook", definition_id: null, definition_version: null },
      expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} }, started_at: "2026-08-18T00:00:00.000Z", parent_run_id: null, metadata: {},
    },
    batches: [],
    complete: {
      protocol_version: "0.1", run_id: RUN_ID, idempotency_key: "complete-webhook-001", status: "completed", completed_at: "2026-08-18T00:00:01.000Z",
      actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 }, errors: [], metadata: {},
    },
  };
}

class Service implements ProducerLifecycleService {
  readonly calls: string[] = [];
  async beginRunWithWireId(runId: string): Promise<unknown> { this.calls.push(`begin:${runId}`); return { run_id: runId }; }
  async submitBatch(runId: string): Promise<unknown> { this.calls.push(`batch:${runId}`); return { run_id: runId }; }
  async completeRun(runId: string): Promise<unknown> { this.calls.push(`complete:${runId}`); return { run_id: runId, status: "completed" }; }
}

function signed(raw: string, timestamp?: string): Record<string, string> {
  const message = timestamp === undefined ? raw : `${timestamp}.${raw}`;
  const signature = createHmac("sha256", SECRET).update(message).digest("hex");
  return {
    "content-type": "application/json",
    "x-webhook-signature": timestamp === undefined ? `sha256=${signature}` : `t=${timestamp},v1=${signature}`,
    "x-event-id": "event_webhook_001",
    ...(timestamp === undefined ? {} : { "x-webhook-timestamp": timestamp }),
  };
}

function adapter(service = new Service(), mapper?: GenericWebhookMapper): { adapter: GenericWebhookInputAdapter; service: Service } {
  const options = mapper === undefined
    ? { service, principal: PRINCIPAL, secret: SECRET }
    : { service, principal: PRINCIPAL, secret: SECRET, mapper };
  return {
    service,
    adapter: new GenericWebhookInputAdapter(options),
  };
}

test("verifies raw-body HMAC before mapping and delegates a mapped bundle", async () => {
  const { adapter, service } = adapterFactory();
  const raw = JSON.stringify({ upstream_claim: "untrusted" });
  const result = await adapter.ingest({ raw_body: raw, headers: signed(raw) });
  assert.equal(result.event_id, "event_webhook_001");
  assert.equal(result.run_id, RUN_ID);
  assert.deepEqual(service.calls, [`begin:${RUN_ID}`, `complete:${RUN_ID}`]);
});

function adapterFactory(): { adapter: GenericWebhookInputAdapter; service: Service } {
  const service = new Service();
  return adapter(service, async (_payload, context) => {
    assert.equal(context.signature.verified, true);
    assert.equal(context.event_id, "event_webhook_001");
    return bundle();
  });
}

test("rejects invalid signature, replayed timestamp, and mapper failure without lifecycle side effects", async () => {
  const service = new Service();
  const configured = new GenericWebhookInputAdapter({
    service,
    principal: PRINCIPAL,
    secret: SECRET,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    mapper: () => { throw new Error("secret mapper detail"); },
  });
  const raw = JSON.stringify({ hello: "world" });
  await assert.rejects(configured.ingest({ raw_body: raw, headers: { ...signed(raw), "x-webhook-signature": "sha256=00".repeat(1) } }), (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "signature_invalid");
  await assert.rejects(configured.ingest({ raw_body: raw, headers: signed(raw, "1") }), (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "signature_timestamp_invalid");
  const valid = signed(raw);
  await assert.rejects(configured.ingest({ raw_body: raw, headers: valid }), (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "mapping_failed" && error.message.includes("secret") === false);
  assert.deepEqual(service.calls, []);
});

test("requires a stable event ID and exposes only safe mapper headers", async () => {
  const service = new Service();
  let observed: Readonly<Record<string, string>> | undefined;
  const adapter = new GenericWebhookInputAdapter({
    service,
    principal: PRINCIPAL,
    secret: SECRET,
    mapper: (_payload, context) => {
      observed = context.headers;
      return bundle();
    },
  });
  const raw = JSON.stringify({ safe: true });
  const signature = signed(raw);
  const headers: Record<string, string> = {
    ...signature,
    authorization: "Bearer mapper-secret",
    cookie: "session-secret",
    "x-webhook-signature": signature["x-webhook-signature"]!,
  };
  await adapter.ingest({ raw_body: raw, headers });
  assert.deepEqual(observed, {
    "content-type": "application/json",
    "x-event-id": "event_webhook_001",
  });
  assert.equal(JSON.stringify(adapter).includes(SECRET), false);

  const { "x-event-id": _eventId, ...missingId } = headers;
  await assert.rejects(
    adapter.ingest({ raw_body: raw, headers: missingId }),
    (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "event_id_missing",
  );
});

test("rejects a replayed event before mapping or lifecycle calls", async () => {
  const service = new Service();
  let mapped = 0;
  const adapter = new GenericWebhookInputAdapter({
    service,
    principal: PRINCIPAL,
    secret: SECRET,
    mapper: () => { mapped += 1; return bundle(); },
  });
  const raw = JSON.stringify({ replay: true });
  const headers = signed(raw);
  await adapter.ingest({ raw_body: raw, headers });
  await assert.rejects(
    adapter.ingest({ raw_body: raw, headers }),
    (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "event_replayed",
  );
  assert.equal(mapped, 1);
  assert.deepEqual(service.calls, [`begin:${RUN_ID}`, `complete:${RUN_ID}`]);
});

test("uses the durable replay boundary across adapter instances", async () => {
  const claimed = new Map<string, string>();
  const replayStore = {
    claim: async (eventId: string, bodySha256: string): Promise<boolean> => {
      if (claimed.has(eventId)) return false;
      claimed.set(eventId, bodySha256);
      return true;
    },
  };
  const raw = JSON.stringify({ durable_replay: true });
  const headers = signed(raw);
  const first = adapter(new Service(), () => bundle()).adapter;
  const second = new GenericWebhookInputAdapter({ service: new Service(), principal: PRINCIPAL, secret: SECRET, replay_store: replayStore, mapper: () => bundle() });
  // The first adapter is deliberately not given the durable store; the second
  // demonstrates that only a configured durable boundary survives instances.
  await first.ingest({ raw_body: raw, headers });
  await second.ingest({ raw_body: raw, headers });
  const third = new GenericWebhookInputAdapter({ service: new Service(), principal: PRINCIPAL, secret: SECRET, replay_store: replayStore, mapper: () => bundle() });
  await assert.rejects(
    third.ingest({ raw_body: raw, headers }),
    (error: unknown) => error instanceof GenericWebhookAdapterError && error.code === "event_replayed",
  );
});

test("classifies an invalid mapper bundle separately from lifecycle failure", async () => {
  const service = new Service();
  const adapter = new GenericWebhookInputAdapter({
    service,
    principal: PRINCIPAL,
    secret: SECRET,
    mapper: () => ({ invalid: true } as unknown as RunBundle),
  });
  const raw = JSON.stringify({ invalid: true });
  await assert.rejects(
    adapter.ingest({ raw_body: raw, headers: signed(raw) }),
    (error: unknown) => error instanceof GenericWebhookAdapterError
      && error.code === "bundle_invalid"
      && error.details.phase === "mapping",
  );
  assert.deepEqual(service.calls, []);
});

test("surfaces a redacted recovery artifact when the lifecycle cannot close", async () => {
  const service = new Service();
  service.submitBatch = async (runId: string) => { service.calls.push(`batch:${runId}`); throw new Error("authorization bearer secret"); };
  const source = bundle();
  source.batches = [{
    protocol_version: "0.1", run_id: RUN_ID, batch_id: "batch-001", idempotency_key: "batch-webhook-001", sequence_number: 1, submitted_at: "2026-08-18T00:00:00.500Z", findings: [], evidence: [{
      evidence_id: "evidence-001", kind: "other", source: { uri: "urn:webhook:source", title: null, publisher: null, source_id: null }, captured_at: "2026-08-18T00:00:00.500Z", published_at: null, locator: null, excerpt: "untrusted", content_hash: null, artifact: { uri: null, media_type: null, size_bytes: null }, handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false }, metadata: {},
    }], metadata: {},
  }];
  const configured = new GenericWebhookInputAdapter({ service, principal: PRINCIPAL, secret: SECRET, mapper: () => source });
  const raw = JSON.stringify({ hook: true });
  await assert.rejects(configured.ingest({ raw_body: raw, headers: signed(raw) }), (error: unknown) => {
    assert.ok(error instanceof GenericWebhookImportFailure);
    assert.equal(error.message.includes("secret"), false);
    assert.equal(Object.keys(error).includes("recovery"), false);
    assert.equal(JSON.stringify(error).includes('"bundle"'), false);
    assert.equal(error.recovery.run_id, RUN_ID);
    return true;
  });
  assert.deepEqual(service.calls, [`begin:${RUN_ID}`, `batch:${RUN_ID}`, `complete:${RUN_ID}`]);
});
