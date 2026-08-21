import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  planLargeRunBatches,
  type Finding,
  type LargeRunUnit,
  type SubmittedEvidence,
} from "../../packages/sdk/typescript/src/index.ts";
import {
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
  type BeginRunRequest,
  type CompleteRunRequest,
  type SubmitBatchRequest,
} from "../../packages/persistence-postgres/src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const SUBMITTED_AT = "2026-08-21T04:00:00.000Z";

function evidence(index: number): SubmittedEvidence {
  return {
    evidence_id: `large-evidence-${String(index).padStart(4, "0")}`,
    kind: "web",
    source: { uri: `https://example.test/large/${index}`, title: null, publisher: null, source_id: `source-${index}` },
    captured_at: SUBMITTED_AT,
    published_at: null,
    locator: null,
    excerpt: `Authorized synthetic scale evidence ${index}`,
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
    metadata: {},
  };
}

function finding(index: number): Finding {
  return {
    finding_id: `large-finding-${String(index).padStart(4, "0")}`,
    finding_type: "scale.synthetic",
    title: `Synthetic scale finding ${index}`,
    summary: "A non-domain finding used only to prove bounded durable multi-batch ingestion.",
    subjects: [{ type: "source", id: `source-${index}`, name: null }],
    effective_time: { occurred_at: SUBMITTED_AT, effective_from: null, effective_to: null },
    assessment: { novelty: "new", source_authority_claim: "unknown", evidence_completeness: "lead_only", agent_confidence: null },
    evidence_refs: [`large-evidence-${String(index).padStart(4, "0")}`],
    producer_dedupe_key: `large-dedupe-${index}`,
    routing_tags: ["scale.synthetic"],
    attributes: { synthetic: true },
    security_flags: [],
  };
}

function* units(): Generator<LargeRunUnit> {
  for (let index = 1; index <= 250; index += 1) {
    yield { findings: [finding(index)], evidence: [evidence(index)] };
  }
}

test("250 planned units survive durable multi-batch ingestion, completion, and exact terminal retry", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is required for live large-run acceptance",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const tenantId = `large-run-${randomUUID()}`;
  const runId = `large-run-${randomUUID()}`;
  const submittedAt = SUBMITTED_AT;
  try {
    await migrateAgentFeed(pool);
    const store = new PostgresAgentFeedPersistence(pool);
    const begin: BeginRunRequest = {
      protocol_version: "0.1",
      tenant_id: tenantId,
      run_id: runId,
      idempotency_key: `begin-${randomUUID()}`,
      stream_id: "scale.synthetic.large-run",
      producer: { producer_id: "large-run-test", type: "automation", name: "large-run-conformance", version: "1" },
      task: { task_type: "scale-conformance", definition_id: "large-run-v1", definition_version: "1" },
      expected_scope: { source_ids: [], subjects: [], queries: [], metadata: { synthetic: true } },
      started_at: "2026-08-21T03:59:00.000Z",
      parent_run_id: null,
      metadata: { synthetic: true },
    };
    await store.beginRun(begin);

    const acceptedBodies: string[] = [];
    for await (const batch of planLargeRunBatches(runId, units(), { submitted_at: submittedAt })) {
      const durable = { ...batch, tenant_id: tenantId } as unknown as SubmitBatchRequest;
      await store.submitBatch(durable);
      acceptedBodies.push(JSON.stringify(batch));
    }
    assert.equal(acceptedBodies.length, 3);

    const completion: CompleteRunRequest = {
      protocol_version: "0.1",
      tenant_id: tenantId,
      run_id: runId,
      idempotency_key: `complete-${randomUUID()}`,
      status: "completed",
      completed_at: "2026-08-21T04:01:00.000Z",
      actual_scope: { source_ids: [], subjects: [], queries: [], metadata: { synthetic: true } },
      stats: {
        sources_attempted: 250,
        sources_succeeded: 250,
        findings_submitted: 250,
        evidence_submitted: 250,
        batches_submitted: 3,
      },
      errors: [],
      metadata: { synthetic: true },
    };
    const completed = await store.completeRun(completion);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.stats, completion.stats);

    const counts = await pool.query<{ batches: string; findings: string; evidence: string }>(
      `select
         (select count(*) from agent_feed.batches b where b.run_id = r.id)::text as batches,
         (select count(*) from agent_feed.findings f where f.run_id = r.id)::text as findings,
         (select count(*) from agent_feed.submitted_evidence e where e.run_id = r.id)::text as evidence
       from agent_feed.runs r
       where r.tenant_id = $1 and r.wire_run_id = $2`,
      [tenantId, runId],
    );
    assert.deepEqual(counts.rows[0], { batches: "3", findings: "250", evidence: "250" });

    const replayBodies: string[] = [];
    for await (const batch of planLargeRunBatches(runId, units(), { submitted_at: submittedAt })) {
      await store.submitBatch({ ...batch, tenant_id: tenantId } as unknown as SubmitBatchRequest);
      replayBodies.push(JSON.stringify(batch));
    }
    assert.deepEqual(replayBodies, acceptedBodies);
    const afterReplay = await store.getRunForTenant(tenantId, runId);
    assert.equal(afterReplay?.batches.length, 3);
    assert.equal(afterReplay?.findings.length, 250);
    assert.equal(afterReplay?.evidence.length, 250);
  } finally {
    await pool.end();
  }
});
