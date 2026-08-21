import assert from "node:assert/strict";
import test from "node:test";
import {
  planLargeRunBatches,
  ProducerClient,
  type AgentFeedTransport,
  type AgentFeedTransportRequest,
  type AgentFeedTransportResponse,
  type Finding,
  type LargeRunUnit,
  type SubmittedEvidence,
} from "../src/index.ts";

const RUN_ID = "run-large-p0-001";
const SUBMITTED_AT = "2026-08-21T03:00:00.000Z";

function evidence(index: number): SubmittedEvidence {
  return {
    evidence_id: `evidence-${String(index).padStart(4, "0")}`,
    kind: "web",
    source: { uri: `https://example.test/source/${index}`, title: null, publisher: null, source_id: `source-${index}` },
    captured_at: SUBMITTED_AT,
    published_at: null,
    locator: null,
    excerpt: `Source excerpt ${index}`,
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
    metadata: {},
  };
}

function finding(index: number, evidenceId = `evidence-${String(index).padStart(4, "0")}`): Finding {
  return {
    finding_id: `finding-${String(index).padStart(4, "0")}`,
    finding_type: "monitoring.change",
    title: `Finding ${index}`,
    summary: `Bounded finding ${index}`,
    subjects: [{ type: "source", id: `source-${index}`, name: null }],
    effective_time: { occurred_at: SUBMITTED_AT, effective_from: null, effective_to: null },
    assessment: { novelty: "new", source_authority_claim: "unknown", evidence_completeness: "lead_only", agent_confidence: null },
    evidence_refs: [evidenceId],
    producer_dedupe_key: `dedupe-${index}`,
    routing_tags: [],
    attributes: {},
    security_flags: [],
  };
}

function unit(index: number): LargeRunUnit {
  return { findings: [finding(index)], evidence: [evidence(index)] };
}

async function collect(units: Iterable<LargeRunUnit> | AsyncIterable<LargeRunUnit>, overrides: Record<string, unknown> = {}) {
  const batches = [];
  for await (const batch of planLargeRunBatches(RUN_ID, units, { submitted_at: SUBMITTED_AT, ...overrides })) batches.push(batch);
  return batches;
}

test("large-run planner streams 250 atomic units into deterministic bounded batches", async () => {
  function* units() {
    for (let index = 1; index <= 250; index += 1) yield unit(index);
  }

  const first = await collect(units());
  const replay = await collect(units());
  assert.deepEqual(first, replay);
  assert.deepEqual(first.map((batch) => batch.findings.length), [100, 100, 50]);
  assert.deepEqual(first.map((batch) => batch.evidence.length), [100, 100, 50]);
  assert.deepEqual(first.map((batch) => batch.sequence_number), [1, 2, 3]);
  assert.equal(new Set(first.map((batch) => batch.idempotency_key)).size, 3);
  for (const batch of first) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= 1_048_576);
    const available = new Set(batch.evidence.map((item) => item.evidence_id));
    for (const item of batch.findings) assert.ok(item.evidence_refs.every((reference) => available.has(reference)));
  }
});

test("large-run planner enforces body bytes without splitting an atomic unit", async () => {
  const units = Array.from({ length: 6 }, (_, offset) => {
    const value = unit(offset + 1);
    value.findings[0]!.summary = "x".repeat(900);
    return value;
  });
  const batches = await collect(units, { max_body_bytes: 3_500 });
  assert.ok(batches.length > 1);
  assert.equal(batches.reduce((count, batch) => count + batch.findings.length, 0), 6);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= 3_500);

  const oversized = unit(99);
  oversized.findings[0]!.summary = "x".repeat(5_000);
  await assert.rejects(
    async () => collect([oversized], { max_body_bytes: 2_000 }),
    /large_run_unit_exceeds_batch_limit/u,
  );
});

test("large-run planner fails closed on duplicate IDs and forward evidence references", async () => {
  await assert.rejects(async () => collect([unit(1), unit(1)]), /large_run_duplicate_evidence_id/u);
  await assert.rejects(
    async () => collect([{ findings: [finding(1, "evidence-later")], evidence: [] }, { findings: [], evidence: [evidence(2)] }]),
    /large_run_forward_or_missing_evidence_ref/u,
  );
});

class FakeTransport implements AgentFeedTransport {
  readonly requests: AgentFeedTransportRequest[] = [];
  readonly responses: AgentFeedTransportResponse[] = [];

  async request(input: AgentFeedTransportRequest): Promise<AgentFeedTransportResponse> {
    this.requests.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("fake_response_missing");
    return next;
  }
}

test("submitLargeRun applies sequential backpressure and reports durable progress", async () => {
  const transport = new FakeTransport();
  transport.responses.push(
    { status: 202, body: { run_id: RUN_ID, status: "running" }, headers: {} },
    { status: 202, body: { run_id: RUN_ID, status: "running" }, headers: {} },
    { status: 202, body: { run_id: RUN_ID, status: "running" }, headers: {} },
  );
  const client = new ProducerClient({
    base_url: "https://feed.example.test",
    transport,
    retry: { max_attempts: 1 },
  });
  const checkpoints: number[] = [];
  const summary = await client.submitLargeRun(
    RUN_ID,
    Array.from({ length: 205 }, (_, index) => unit(index + 1)),
    {
      submitted_at: SUBMITTED_AT,
      on_batch_accepted: ({ batches_submitted }) => { checkpoints.push(batches_submitted); },
    },
  );

  assert.deepEqual(checkpoints, [1, 2, 3]);
  assert.deepEqual(summary, {
    run_id: RUN_ID,
    batches_submitted: 3,
    findings_submitted: 205,
    evidence_submitted: 205,
    last_sequence_number: 3,
  });
  assert.equal(transport.requests.length, 3);
  assert.deepEqual(transport.requests.map((request) => JSON.parse(request.body ?? "{}").sequence_number), [1, 2, 3]);
});

test("regenerating a stopped large run produces byte-equal exact retries", async () => {
  const source = Array.from({ length: 150 }, (_, index) => unit(index + 1));
  const firstPlan = await collect(source, { max_findings_per_batch: 50, max_evidence_per_batch: 50 });
  const replayPlan = await collect(source, { max_findings_per_batch: 50, max_evidence_per_batch: 50 });
  assert.deepEqual(firstPlan, replayPlan);
  assert.deepEqual(
    firstPlan.map((batch) => JSON.stringify(batch)),
    replayPlan.map((batch) => JSON.stringify(batch)),
  );

  const left = unit(999);
  left.findings[0]!.attributes = { z: 1, a: { y: true, b: false } };
  const right = unit(999);
  right.findings[0]!.attributes = { a: { b: false, y: true }, z: 1 };
  const [leftBatch] = await collect([left], { metadata: { z: 1, a: 2 } });
  const [rightBatch] = await collect([right], { metadata: { a: 2, z: 1 } });
  assert.equal(JSON.stringify(leftBatch), JSON.stringify(rightBatch), "object insertion order is not wire identity");
});
