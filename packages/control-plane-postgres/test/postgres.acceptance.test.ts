import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  PostgresAgentFeedPersistence,
  PostgresOccurrenceRepository,
  createAgentFeedPool,
  migrateAgentFeed,
  type BeginRunRequest,
  type CompleteRunRequest,
} from "@agent-feed/persistence-postgres";
import { PostgresControlPlaneRepository } from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

function begin(tenantId: string, streamId: string, startedAt: string): BeginRunRequest {
  return {
    protocol_version: "0.1", tenant_id: tenantId, idempotency_key: `m10-begin-${randomUUID()}`,
    stream_id: streamId, producer: { producer_id: "m10-test", type: "automation", name: "m10", version: "1" },
    task: { task_type: "m10-control-plane", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} }, started_at: startedAt,
    parent_run_id: null, metadata: {}, run_id: `m10-run-${randomUUID()}`,
  };
}

function completion(tenantId: string, runId: string, completedAt: string): CompleteRunRequest {
  return {
    protocol_version: "0.1", tenant_id: tenantId, run_id: runId,
    idempotency_key: `m10-complete-${randomUUID()}`, status: "completed", completed_at: completedAt,
    actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    errors: [], metadata: {},
  };
}

test("live PostgreSQL projection isolates tenants and distinguishes completed-zero from absence", {
  skip: databaseUrl === undefined ? "AGENT_FEED_DATABASE_URL is required for live M10 acceptance" : false,
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const tenantId = `m10_${randomUUID()}`;
  const otherTenant = `m10_other_${randomUUID()}`;
  try {
    await migrateAgentFeed(pool);
    await migrateAgentFeed(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    const occurrence = new PostgresOccurrenceRepository(pool);
    const repository = new PostgresControlPlaneRepository(pool);
    const streamId = `m10-stream-${randomUUID()}`;
    const schedule = await occurrence.createScheduleExpectationVersion({
      tenant_id: tenantId, schedule_key: `m10-schedule-${randomUUID()}`, stream_id: streamId, version: 1,
      schedule_kind: "interval", interval_seconds: 3_600, cron_expression: null, timezone: "UTC",
      anchor_at: "2026-08-20T00:00:00.000Z", matching_mode: "explicit", misfire_policy: "mark_missed",
      overlap_policy: "allow", grace_seconds: 60, enabled: true,
      expected_scope: { source_ids: [], subjects: [] }, owner: "m10-test", notes: "",
    });
    const expected = await occurrence.materializeScheduleOccurrences({
      tenant_id: tenantId, schedule_version_id: schedule.id,
      from: "2026-08-20T00:00:00.000Z", to: "2026-08-20T01:00:00.000Z",
    });
    assert.equal(expected.length, 2);
    const run = await persistence.beginRun(begin(tenantId, streamId, expected[0]!.expected_at));
    await occurrence.recordTrustedRunTriggerContext({
      tenant_id: tenantId, run_id: run.run_id, trigger_kind: "scheduled",
      schedule_version_id: schedule.id, trusted_source: "m10-test-adapter", metadata: {},
    });
    await occurrence.linkRunToOccurrence({
      tenant_id: tenantId, run_id: run.run_id, schedule_version_id: schedule.id,
      occurrence_id: expected[0]!.id,
    });
    await persistence.completeRun(completion(tenantId, run.run_id, "2026-08-20T00:00:30.000Z"));
    await persistence.beginRun(begin(otherTenant, `other-${randomUUID()}`, "2026-08-20T00:30:00.000Z"));

    const snapshot = await repository.getSnapshot({
      tenantId, asOf: "2026-08-20T02:00:00.000Z", observationWindowSeconds: 7_200,
    });
    assert.equal(snapshot.runs.total, 1);
    assert.equal(snapshot.runs.byState.completed, 1);
    assert.equal(snapshot.occurrences.total, 2);
    assert.equal(snapshot.occurrences.byState.completed_zero, 1);
    assert.equal(snapshot.occurrences.byState.absent, 1);
    assert.equal(snapshot.health, "critical");
    assert.equal(JSON.stringify(snapshot).includes("m10-test-adapter"), false);

    const other = await repository.getSnapshot({
      tenantId: otherTenant, asOf: "2026-08-20T02:00:00.000Z", observationWindowSeconds: 7_200,
    });
    assert.equal(other.runs.total, 1);
    assert.equal(other.occurrences.total, 0);
  } finally {
    await pool.end();
  }
});
