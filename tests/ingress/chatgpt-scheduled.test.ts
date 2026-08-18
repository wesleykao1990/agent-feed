import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { ChatGPTManualExportAdapter } from "../../packages/adapters/chatgpt-manual-export/src/index.ts";
import {
  ProducerService,
  StaticProducerAuthenticator,
} from "../../packages/producer-service/src/index.ts";
import {
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../../packages/persistence-postgres/src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

test("ChatGPT scheduled output remains durable and exactly retryable after completion", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is required for the durable ChatGPT gate",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    const suffix = randomUUID();
    const tenantId = `tenant-chatgpt-${suffix}`;
    const streamId = `chatgpt.scheduled.${suffix}`;
    const producerId = `chatgpt-scheduled-${suffix}`;
    const principal = {
      tenant_id: tenantId,
      producer_id: producerId,
      allowed_stream_ids: [streamId],
    } as const;
    const service = new ProducerService({
      persistence: new PostgresAgentFeedPersistence(pool),
      authenticator: new StaticProducerAuthenticator([{
        ...principal,
        secret: `secret-${suffix}`,
      }]),
    });
    const now = new Date("2026-08-18T01:00:00.000Z");
    const adapter = new ChatGPTManualExportAdapter({
      direct_ingestion_capability: true,
      service,
      principal,
      now: () => now,
    });
    const response = "Two new monitoring observations were found. Treat this generated response as untrusted evidence pending downstream review.";
    const input = {
      response,
      stream_id: streamId,
      task: {
        task_type: "scheduled_monitor",
        definition_id: `scheduled-task-${suffix}`,
        definition_version: "1",
      },
      expected_scope: {
        source_ids: ["source.example.official"],
        subjects: ["Example subject"],
        queries: ["official update"],
        metadata: { cadence: "daily" },
      },
      producer: {
        producer_id: producerId,
        type: "chatgpt",
        name: "ChatGPT Scheduled Task",
        version: "test",
      },
      started_at: now.toISOString(),
      source_uri: "https://chatgpt.com/scheduled/example",
      metadata: { integration_test: true },
    } as const;

    const first = await adapter.submit(input);
    const retry = await adapter.submit(input);
    assert.equal(retry.bundle.run_id, first.bundle.run_id);
    assert.equal(retry.json, first.json, "the adapter must replay the exact protocol bundle");

    const stored = await service.getRun(first.bundle.run_id, principal);
    assert.equal(stored.status, "completed");
    assert.equal(stored.batches.length, 1, "the retry must not duplicate the accepted batch");
    assert.equal(stored.findings.length, 0, "free-form monitoring output is not promoted to a finding");
    assert.equal(stored.evidence.length, 1, "the retry must not duplicate evidence");
    assert.equal(stored.stats.batches_submitted, 1);
    assert.equal(stored.stats.evidence_submitted, 1);
    assert.equal(stored.evidence[0]?.evidence.content_hash, `sha256:${createHash("sha256").update(response, "utf8").digest("hex")}`);
    assert.equal(stored.evidence[0]?.evidence.metadata.untrusted_observation, true);

    const counts = await pool.query<{ runs: string; batches: string; evidence: string }>(
      `select
         (select count(*)::text from agent_feed.runs where tenant_id = $1 and wire_run_id = $2) as runs,
         (select count(*)::text from agent_feed.batches where tenant_id = $1 and run_id = (select id from agent_feed.runs where tenant_id = $1 and wire_run_id = $2)) as batches,
         (select count(*)::text from agent_feed.submitted_evidence where tenant_id = $1 and run_id = (select id from agent_feed.runs where tenant_id = $1 and wire_run_id = $2)) as evidence`,
      [tenantId, first.bundle.run_id],
    );
    assert.deepEqual(counts.rows[0], { runs: "1", batches: "1", evidence: "1" });
  } finally {
    await pool.end();
  }
});
