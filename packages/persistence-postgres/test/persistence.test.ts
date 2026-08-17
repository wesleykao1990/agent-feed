import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  PersistenceError,
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
  canonicalJson,
  payloadHash,
} from "../src/index.ts";
import type { BeginRunRequest, CompleteRunRequest, EvidencePayload, FindingPayload, SubmitBatchRequest } from "../src/index.ts";

const migrationPath = new URL("../migrations/0001_agent_feed.sql", import.meta.url);
const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

test("canonical payload hashes ignore object key order and reject undefined", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ invalid: undefined }), /undefined/);
});

test("migration contains the isolated schema, append-only guards, liveness, and no delivery worker", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const marker of [
    "create schema if not exists agent_feed",
    "agent_feed.runs",
    "agent_feed.batches",
    "agent_feed.findings",
    "agent_feed.submitted_evidence",
    "agent_feed.finding_evidence",
    "agent_feed.stream_expectations",
    "protect_terminal_run",
    "protect_accepted_record",
    "sweep_overdue_streams",
    "begin_payload_hash",
    "complete_payload_hash",
  ]) assert.match(sql, new RegExp(marker.replaceAll(".", "\\."), "i"));
  assert.doesNotMatch(sql, /delivery_attempts|create\s+function[^]*deliver/i);
});

function beginInput(streamId = `test.${randomUUID()}`): BeginRunRequest {
  return {
    protocol_version: "0.1",
    idempotency_key: `begin-${randomUUID()}`,
    stream_id: streamId,
    producer: { producer_id: "postgres-test", type: "automation", name: "persistence-test", version: "1" },
    task: { task_type: "regression", definition_id: null, definition_version: null },
    expected_scope: { source_ids: ["source-1"], subjects: ["subject-1"], queries: ["query"], metadata: {} },
    started_at: "2026-08-17T00:00:00.000Z",
    parent_run_id: null,
    metadata: { test: true },
    run_id: randomUUID(),
  };
}

const evidence = (id: string): EvidencePayload => ({
  evidence_id: id,
  kind: "web",
  source: { uri: "https://example.invalid/article", title: "Synthetic", publisher: "Test", source_id: "source-1" },
  captured_at: "2026-08-17T00:00:00.000Z",
  published_at: null,
  locator: null,
  excerpt: "Synthetic evidence",
  content_hash: null,
  artifact: { uri: null, media_type: null, size_bytes: null },
  handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
  metadata: {},
});

const finding = (id: string, evidenceId: string): FindingPayload => ({
  finding_id: id,
  finding_type: "synthetic.test",
  title: "Synthetic finding",
  summary: "A finding used by the persistence regression test.",
  subjects: [{ type: "test", id: "subject-1", name: "Subject" }],
  effective_time: { occurred_at: null, effective_from: null, effective_to: null },
  assessment: { novelty: "new", source_authority_claim: "unknown", evidence_completeness: "complete", agent_confidence: 0.5 },
  evidence_refs: [evidenceId],
  producer_dedupe_key: null,
  routing_tags: ["test"],
  attributes: { synthetic: true },
  security_flags: [],
});

function completeInput(runId: string, stats: CompleteRunRequest["stats"], status: CompleteRunRequest["status"] = "completed"): CompleteRunRequest {
  return {
    protocol_version: "0.1",
    run_id: runId,
    idempotency_key: `complete-${randomUUID()}`,
    status,
    completed_at: "2026-08-17T00:01:00.000Z",
    actual_scope: { source_ids: ["source-1"], subjects: ["subject-1"], queries: ["query"], metadata: {} },
    stats,
    errors: [],
    metadata: { complete: true },
  };
}

test("live PostgreSQL persistence regression suite", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live PostgreSQL gate not executed" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    const store = new PostgresAgentFeedPersistence(pool);

    const begin = beginInput();
    const first = await store.beginRun(begin);
    const retry = await store.beginRun({ ...begin });
    assert.equal(retry.run_id, first.run_id);
    await assert.rejects(
      store.beginRun({ ...begin, metadata: { changed: true } }),
      (error: unknown) => error instanceof PersistenceError && error.code === "idempotency_payload_conflict",
    );

    const batch: SubmitBatchRequest = {
      protocol_version: "0.1",
      run_id: first.run_id,
      batch_id: `batch-${randomUUID()}`,
      idempotency_key: `batch-key-${randomUUID()}`,
      sequence_number: 1,
      submitted_at: "2026-08-17T00:00:30.000Z",
      findings: [finding("finding-1", "evidence-1")],
      evidence: [evidence("evidence-1")],
      metadata: {},
    };
    const accepted = await store.submitBatch(batch);
    assert.equal(accepted.batches.length, 1);
    assert.equal(accepted.findings.length, 1);
    assert.equal(accepted.evidence.length, 1);
    const batchRetry = await store.submitBatch({ ...batch });
    assert.equal(batchRetry.batches.length, 1);
    await assert.rejects(
      store.submitBatch({ ...batch, metadata: { changed: true } }),
      (error: unknown) => error instanceof PersistenceError && error.code === "idempotency_payload_conflict",
    );
    await assert.rejects(
      store.submitBatch({ ...batch, batch_id: `batch-${randomUUID()}`, idempotency_key: `batch-key-${randomUUID()}`, sequence_number: 2, findings: [finding("finding-missing", "missing-evidence")], evidence: [] }),
      (error: unknown) => error instanceof PersistenceError && error.code === "unresolved_evidence_ref",
    );
    assert.equal((await store.getRun(first.run_id))?.batches.length, 1, "failed batch must roll back atomically");

    const complete = completeInput(first.run_id, { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 1, batches_submitted: 1 });
    const completed = await store.completeRun(complete);
    assert.equal(completed.status, "completed");
    assert.equal(completed.stats.findings_submitted, 1);
    const completeRetry = await store.completeRun({ ...complete });
    assert.equal(completeRetry.run_id, completed.run_id);
    await assert.rejects(
      store.completeRun({ ...complete, metadata: { changed: true } }),
      (error: unknown) => error instanceof PersistenceError && error.code === "idempotency_payload_conflict",
    );
    await assert.rejects(
      store.completeRun({ ...complete, idempotency_key: `complete-other-${randomUUID()}` }),
      (error: unknown) => error instanceof PersistenceError && error.code === "terminal_run_immutable",
    );
    await assert.rejects(
      store.submitBatch({ ...batch, idempotency_key: `batch-after-${randomUUID()}`, batch_id: `batch-after-${randomUUID()}`, sequence_number: 2 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "terminal_run_immutable",
    );

    const directRunUpdate = pool.query(`update agent_feed.runs set status = 'failed' where id = $1`, [first.run_id]);
    await assert.rejects(directRunUpdate, /immutable|terminal/i);
    const directFindingUpdate = pool.query(`update agent_feed.findings set finding_type = 'tampered' where run_id = $1`, [first.run_id]);
    await assert.rejects(directFindingUpdate, /immutable/i);

    const concurrentRun = await store.beginRun(beginInput());
    const concurrentBase: SubmitBatchRequest = {
      ...batch,
      run_id: concurrentRun.run_id,
      batch_id: `concurrent-a-${randomUUID()}`,
      idempotency_key: `concurrent-key-${randomUUID()}`,
      findings: [],
      evidence: [evidence(`concurrent-evidence-a-${randomUUID()}`)],
    };
    const concurrentChanged: SubmitBatchRequest = {
      ...concurrentBase,
      batch_id: `concurrent-b-${randomUUID()}`,
      evidence: [evidence(`concurrent-evidence-b-${randomUUID()}`)],
    };
    const concurrentResults = await Promise.allSettled([
      store.submitBatch(concurrentBase),
      store.submitBatch(concurrentChanged),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === "rejected" && result.reason instanceof PersistenceError && result.reason.code === "idempotency_payload_conflict").length, 1);

    const zeroStream = `test.zero.${randomUUID()}`;
    await store.registerStreamExpectation({ stream_id: zeroStream, expected_cadence_seconds: 3_600, grace_seconds: 0, enabled: true, expected_scope: { source_ids: ["source-1"], subjects: [] }, owner: "test", notes: "zero run" });
    const zeroBegin = beginInput(zeroStream);
    const zeroRun = await store.beginRun({ ...zeroBegin, started_at: "2026-08-17T00:00:00.000Z" });
    const zeroComplete = completeInput(zeroRun.run_id, { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 });
    const zero = await store.completeRun(zeroComplete);
    assert.equal(zero.findings.length, 0);
    assert.equal((await store.listRuns({ stream_id: zeroStream, status: "completed" })).length, 1);
    const expectation = await store.getStreamExpectation(zeroStream);
    assert.equal(expectation?.last_terminal_status, "completed");
    assert.equal(expectation?.next_due_at, "2026-08-17T01:01:00.000Z");
    const liveness = await store.sweepOverdueStreams(new Date("2026-08-17T02:00:00.000Z"));
    assert.equal(liveness.find((item) => item.stream_id === zeroStream)?.liveness_status, "overdue");
  } finally {
    await pool.end();
  }
});
