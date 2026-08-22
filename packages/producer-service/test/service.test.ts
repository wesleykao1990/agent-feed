import assert from "node:assert/strict";
import test from "node:test";
import {
  ProducerService,
  ProducerServiceError,
  StaticProducerAuthenticator,
  type BeginRunRequest,
  type CompleteRunRequest,
  type ProducerPersistence,
  type ProducerPrincipal,
  type RunRecord,
  type SubmitBatchRequest,
} from "../src/index.ts";

const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant_a",
  producer_id: "producer_a",
  allowed_stream_ids: ["stream.a"],
};

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
  beginInputs: BeginRunRequest[] = [];
  submitInputs: SubmitBatchRequest[] = [];
  completeInputs: CompleteRunRequest[] = [];

  async beginRun(input: BeginRunRequest): Promise<RunRecord> {
    this.beginInputs.push(input);
    const result = run({ run_id: input.run_id ?? "run_aaaaaaaa", tenant_id: input.tenant_id ?? "default", producer_id: input.producer.producer_id, stream_id: input.stream_id });
    this.runs.set(result.run_id, result);
    return result;
  }

  async submitBatch(input: SubmitBatchRequest): Promise<RunRecord> {
    this.submitInputs.push(input);
    const result = this.runs.get(input.run_id);
    if (!result) throw new Error("missing fixture run");
    return result;
  }

  async completeRun(input: CompleteRunRequest): Promise<RunRecord> {
    this.completeInputs.push(input);
    const result = this.runs.get(input.run_id);
    if (!result) throw new Error("missing fixture run");
    return result;
  }

  async getRunForTenant(tenantId: string, runId: string): Promise<RunRecord | null> {
    const result = this.runs.get(runId) ?? null;
    return result?.tenant_id === tenantId ? result : null;
  }
}

function service(fake: FakePersistence): ProducerService {
  return new ProducerService({
    persistence: fake,
    authenticator: new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["stream.a"] }]),
  });
}

function evidencePayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence_id: id,
    kind: "web",
    source: { uri: "https://example.invalid/source", title: "Fixture", publisher: "Fixture", source_id: "fixture" },
    captured_at: "2026-08-18T00:00:01.000Z",
    published_at: null,
    locator: null,
    excerpt: "bounded fixture excerpt",
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
    metadata: {},
    ...overrides,
  };
}

function batchPayload(runId: string, evidence: Record<string, unknown>[]): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    run_id: runId,
    batch_id: `batch_${evidence.length}_${Math.random().toString(16).slice(2)}`,
    idempotency_key: `batch-key-${evidence.length}-${Math.random().toString(16).slice(2)}`,
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [],
    evidence,
    metadata: {},
  };
}

function requirementOnlyDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    classification: "requirement_only",
    kind: "two_factor_authentication_phone",
    required: true,
    value_included: false,
    ...overrides,
  };
}

test("producer application validates the published schema, injects tenant scope, and delegates durable lifecycle operations", async () => {
  const fake = new FakePersistence();
  const application = service(fake);
  const created = await application.beginRun(BEGIN, PRINCIPAL);
  assert.equal(fake.beginInputs[0]?.tenant_id, "tenant_a");
  assert.equal(created.tenant_id, "tenant_a");

  await assert.rejects(
    application.beginRun({ ...BEGIN, streamId: "stream.a" }, PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "schema_validation_failed",
  );
  await assert.rejects(
    application.beginRun({ ...BEGIN, metadata: { token: "not-allowed" } }, PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "secret_field_rejected",
  );
  assert.throws(
    () => new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "*", secret: "secret-a", allowed_stream_ids: ["stream.a"] }]),
    /wildcard_producer_credentials_are_not_allowed/u,
  );
  assert.throws(
    () => new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["*"] }]),
    /wildcard_producer_credentials_are_not_allowed/u,
  );
});

test("accepts an exact requirement-only descriptor without accepting a credential value", async () => {
  const fake = new FakePersistence();
  const application = service(fake);
  const metadata = {
    reward_claims: {
      credential: requirementOnlyDescriptor(),
      authentication: requirementOnlyDescriptor({ kind: "identity_verification" }),
    },
  };

  await application.beginRun({ ...BEGIN, metadata }, PRINCIPAL);
  assert.deepEqual(fake.beginInputs[0]?.metadata, metadata);
});

test("accepts the descriptor in an open finding attribute without changing the protocol boundary", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run());
  const application = service(fake);
  const finding = {
    finding_id: "finding_reward_001",
    finding_type: "rewards.claim",
    title: "Synthetic requirement",
    summary: "A synthetic eligibility requirement claim.",
    subjects: [{ type: "program", id: "synthetic", name: "Synthetic" }],
    effective_time: { occurred_at: null, effective_from: null, effective_to: null },
    assessment: {
      novelty: "new",
      source_authority_claim: "unknown",
      evidence_completeness: "partial",
      agent_confidence: null,
    },
    evidence_refs: [],
    producer_dedupe_key: null,
    routing_tags: [],
    attributes: {
      reward_claims: {
        claims: [{ value: { credential: requirementOnlyDescriptor() } }],
      },
    },
    security_flags: [],
  };
  const batch = { ...batchPayload("run_aaaaaaaa", []), findings: [finding] };

  await application.submitBatch("run_aaaaaaaa", batch, PRINCIPAL);
  assert.equal(fake.submitInputs.length, 1);
});

test("rejects scalar, expanded, included, nested, accessor, and hidden credential descriptors", async () => {
  const accessorDescriptor = requirementOnlyDescriptor();
  Object.defineProperty(accessorDescriptor, "kind", {
    enumerable: true,
    configurable: true,
    get: () => "two_factor_authentication_phone",
  });
  const hiddenDescriptor = requirementOnlyDescriptor();
  Object.defineProperty(hiddenDescriptor, "token", { enumerable: false, value: "opaque-value" });
  const proxyDescriptor = new Proxy(requirementOnlyDescriptor(), {});
  const rejected: Array<[string, unknown]> = [
    ["scalar", "two-factor-authentication phone number"],
    ["extra field", requirementOnlyDescriptor({ value: "not permitted" })],
    ["included value", requirementOnlyDescriptor({ value_included: true })],
    ["nested token", requirementOnlyDescriptor({ details: { token: "opaque-value" } })],
    ["accessor", accessorDescriptor],
    ["hidden field", hiddenDescriptor],
    ["proxy", proxyDescriptor],
  ];

  for (const [label, credential] of rejected) {
    const fake = new FakePersistence();
    await assert.rejects(
      service(fake).beginRun({ ...BEGIN, metadata: { claim: { credential } } }, PRINCIPAL),
      (error: unknown) => error instanceof ProducerServiceError && error.code === "secret_field_rejected",
      label,
    );
    assert.equal(fake.beginInputs.length, 0, `${label} must be rejected before persistence`);
  }
});

test("adapter errors cross the persistence port without a concrete adapter dependency", async () => {
  const known = new FakePersistence();
  known.beginRun = async () => {
    throw Object.assign(new Error("run already exists with a different payload"), {
      code: "idempotency_payload_conflict",
      details: { run_id: "run_aaaaaaaa" },
    });
  };
  await assert.rejects(
    service(known).beginRun(BEGIN, PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError
      && error.code === "idempotency_payload_conflict"
      && error.status === 409
      && error.message === "idempotency_payload_conflict"
      && Object.keys(error.details).length === 0,
  );

  const unknown = new FakePersistence();
  unknown.beginRun = async () => {
    throw Object.assign(new Error("internal adapter detail"), { code: "unexpected_adapter_error" });
  };
  await assert.rejects(
    service(unknown).beginRun(BEGIN, PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError
      && error.code === "storage_error"
      && error.status === 503
      && error.message === "database operation failed",
  );
});

test("run lookups collapse tenant, producer, and stream mismatches into scoped 404s", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run({ tenant_id: "tenant_b", producer_id: "producer_b", stream_id: "stream.b" }));
  const application = service(fake);
  await assert.rejects(
    application.getRun("run_aaaaaaaa", PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "run_not_found" && error.status === 404,
  );
});

test("local-file adapter entrypoint preserves arbitrary producer wire run IDs for durable persistence", async () => {
  const fake = new FakePersistence();
  const application = service(fake);
  const wireRunId = "run_zero_findings_20260817_001";
  const created = await application.beginRunWithWireId(wireRunId, BEGIN, PRINCIPAL);
  assert.equal(created.run_id, wireRunId);
  assert.equal(fake.beginInputs[0]?.run_id, wireRunId);
});

test("path and body run IDs must match before PostgreSQL is called", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run());
  const application = service(fake);
  const batch = {
    protocol_version: "0.1",
    run_id: "run_bbbbbbbb",
    batch_id: "batch_001",
    idempotency_key: "batch-idempotency-a",
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [],
    evidence: [{
      evidence_id: "evidence_001",
      kind: "web",
      source: { uri: "https://example.invalid/source", title: null, publisher: null, source_id: null },
      captured_at: "2026-08-18T00:00:01.000Z",
      published_at: null,
      locator: null,
      excerpt: null,
      content_hash: null,
      artifact: { uri: null, media_type: null, size_bytes: null },
      handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
      metadata: {},
    }],
    metadata: {},
  };
  await assert.rejects(
    application.submitBatch("run_aaaaaaaa", batch, PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "invalid_input",
  );
  assert.equal(fake.submitInputs.length, 0);
});

test("hostile security flags are retained and quarantine hooks receive an identity-aware event", async () => {
  const fake = new FakePersistence();
  const events: unknown[] = [];
  const application = new ProducerService({
    persistence: fake,
    authenticator: new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["stream.a"] }]),
    security: { on_quarantine: (event) => events.push(event) },
  });
  const hostile = {
    ...BEGIN,
    metadata: {},
  };
  await application.beginRun(hostile, PRINCIPAL);
  assert.deepEqual(events, []);
});

test("excerpt limits count Unicode code points and reject before persistence", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run());
  const application = service(fake);
  await application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", [evidencePayload("evidence_4000", { excerpt: "😀".repeat(4000) })]), PRINCIPAL);
  assert.equal(fake.submitInputs.length, 1, "exactly 4000 Unicode code points should be accepted");

  await assert.rejects(
    application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", [evidencePayload("evidence_4001", { excerpt: "😀".repeat(4001) })]), PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "evidence_excerpt_too_large",
  );
  assert.equal(fake.submitInputs.length, 1, "the over-limit request must not mutate persistence");
});

test("evidence count limit accepts 100 items and rejects item 101 before persistence", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run());
  const application = service(fake);
  const atLimit = Array.from({ length: 100 }, (_, index) => evidencePayload(`evidence_${index.toString().padStart(3, "0")}`));
  await application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", atLimit), PRINCIPAL);
  assert.equal(fake.submitInputs.length, 1, "100 evidence items should be accepted");

  const overLimit = Array.from({ length: 101 }, (_, index) => evidencePayload(`evidence_over_${index.toString().padStart(3, "0")}`));
  await assert.rejects(
    application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", overLimit), PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "batch_limit_exceeded",
  );
  assert.equal(fake.submitInputs.length, 1, "the 101-item request must not mutate persistence");
});

test("evidence metadata byte boundary is inclusive and over-limit input is rejected before persistence", async () => {
  const fake = new FakePersistence();
  fake.runs.set("run_aaaaaaaa", run());
  const application = service(fake);
  const targetBytes = 64 * 1024;
  const emptyBytes = Buffer.byteLength(JSON.stringify({ value: "" }), "utf8");
  const exactMetadata = { value: "x".repeat(targetBytes - emptyBytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactMetadata), "utf8"), targetBytes);
  await application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", [evidencePayload("evidence_meta_exact", { metadata: exactMetadata })]), PRINCIPAL);
  assert.equal(fake.submitInputs.length, 1, "metadata exactly at 64 KiB should be accepted");

  const overMetadata = { value: "x".repeat(targetBytes - emptyBytes + 1) };
  assert.equal(Buffer.byteLength(JSON.stringify(overMetadata), "utf8"), targetBytes + 1);
  await assert.rejects(
    application.submitBatch("run_aaaaaaaa", batchPayload("run_aaaaaaaa", [evidencePayload("evidence_meta_over", { metadata: overMetadata })]), PRINCIPAL),
    (error: unknown) => error instanceof ProducerServiceError && error.code === "evidence_metadata_too_large",
  );
  assert.equal(fake.submitInputs.length, 1, "over-limit metadata must not mutate persistence");
});
