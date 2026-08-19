import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  PostgresOperationsRepository,
  migrateOperations,
  retentionOperationId,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_OPERATIONS_DATABASE_URL;

test("live PostgreSQL operations contract is additive, tenant-scoped, and restart-safe", {
  skip: databaseUrl === undefined ? "set AGENT_FEED_OPERATIONS_DATABASE_URL to a dedicated disposable PostgreSQL database" : false,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenant = `ops_live_${randomUUID()}`;
  const otherTenant = `ops_other_${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  try {
    // The root integration gate must apply 0001/0002/0003 before this package
    // migration. This package adds only its own operations schema.
    await migrateOperations(pool);
    const repository = new PostgresOperationsRepository(pool, { maxPlanItems: 10, maxAuditRows: 100 });
    await repository.putPolicy({
      tenantId: tenant,
      policyKey: "recovery",
      artifactClass: "recovery",
      action: "delete",
      retentionSeconds: 1,
    });
    const expired = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "expired-1",
      storageRef: "s3://bucket/expired-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      metadata: { purpose: "acceptance" },
    });
    const retry = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "expired-1",
      storageRef: "s3://bucket/expired-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      metadata: { purpose: "acceptance" },
    });
    assert.equal(retry.id, expired.id);
    await assert.rejects(repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "expired-1",
      storageRef: "s3://bucket/expired-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      legalHold: true,
      metadata: { purpose: "acceptance" },
    }), /idempotency|different/u);

    const held = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "held-1",
      storageRef: "s3://bucket/held-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      legalHold: true,
      metadata: { purpose: "acceptance" },
    });
    const plan = await repository.planRetention({
      tenantId: tenant,
      idempotencyKey: `plan-${randomUUID()}`,
      policyKey: "recovery",
      asOf: "2026-08-18T00:00:00.000Z",
      requestedBy: "live-test",
      maxItems: 10,
    });
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.artifactId, expired.id);
    assert.notEqual(plan.items[0]?.artifactId, held.id);

    let calls = 0;
    const result = await repository.executeRetention(
      { tenantId: tenant, jobId: plan.id, requestedBy: "live-test", confirmationToken: token },
      { apply: async (request) => { calls += 1; assert.equal(request.operationId, retentionOperationId(tenant, plan.id, plan.items[0]!.id)); return { outcome: "deleted" }; } },
    );
    assert.equal(calls, 1);
    assert.equal(result.job.status, "completed");

    // A second worker must observe the live claim, perform no external side
    // effect, and leave the job executing until the claiming worker records
    // the result. This exercises real row locks and separate pool clients.
    const concurrentArtifact = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "concurrent-1",
      storageRef: "s3://bucket/concurrent-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      metadata: { purpose: "acceptance" },
    });
    const concurrentPlan = await repository.planRetention({
      tenantId: tenant,
      idempotencyKey: `plan-${randomUUID()}`,
      policyKey: "recovery",
      asOf: "2026-08-18T00:00:00.000Z",
      requestedBy: "live-test",
      maxItems: 10,
    });
    assert.ok(concurrentPlan.items.some((item) => item.artifactId === concurrentArtifact.id));
    const concurrentToken = randomBytes(32).toString("base64url");
    let concurrentCalls = 0;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const firstWorker = repository.executeRetention(
      { tenantId: tenant, jobId: concurrentPlan.id, requestedBy: "live-test", confirmationToken: concurrentToken },
      { apply: async () => { concurrentCalls += 1; enteredResolve?.(); await release; return { outcome: "deleted" }; } },
    );
    await entered;
    const secondWorkerResult = await repository.executeRetention(
      { tenantId: tenant, jobId: concurrentPlan.id, requestedBy: "live-test", confirmationToken: concurrentToken },
      { apply: async () => { concurrentCalls += 1; return { outcome: "deleted" }; } },
    );
    assert.equal(secondWorkerResult.attempted, 0);
    assert.equal(secondWorkerResult.job.status, "executing");
    releaseResolve?.();
    const firstWorkerResult = await firstWorker;
    assert.equal(firstWorkerResult.job.status, "completed");
    assert.equal(concurrentCalls, 1);

    // A held artifact inserted after planning is skipped under the artifact
    // row lock, before any external adapter call.
    const raceArtifact = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "held-after-plan",
      storageRef: "s3://bucket/held-after-plan",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      metadata: { purpose: "acceptance" },
    });
    const racePlan = await repository.planRetention({
      tenantId: tenant,
      idempotencyKey: `plan-${randomUUID()}`,
      policyKey: "recovery",
      asOf: "2026-08-18T00:00:00.000Z",
      requestedBy: "live-test",
      maxItems: 10,
    });
    assert.ok(racePlan.items.some((item) => item.artifactId === raceArtifact.id));
    await pool.query("update agent_feed.managed_artifacts set legal_hold = true where tenant_id = $1 and id = $2", [tenant, raceArtifact.id]);
    let heldCalls = 0;
    const heldResult = await repository.executeRetention(
      { tenantId: tenant, jobId: racePlan.id, requestedBy: "live-test", confirmationToken: randomBytes(32).toString("base64url") },
      { apply: async () => { heldCalls += 1; return { outcome: "deleted" }; } },
    );
    assert.equal(heldCalls, 0);
    assert.equal(heldResult.job.items.find((item) => item.artifactId === raceArtifact.id)?.status, "skipped");

    // Simulate a crashed worker's expired claim. The next execution resumes
    // with the same job/item operation ID and does not delete any database row.
    const resumeArtifact = await repository.registerArtifact({
      tenantId: tenant,
      artifactKey: "resume-1",
      storageRef: "s3://bucket/resume-1",
      artifactClass: "recovery",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      metadata: { purpose: "acceptance" },
    });
    const resumePlan = await repository.planRetention({
      tenantId: tenant,
      idempotencyKey: `plan-${randomUUID()}`,
      policyKey: "recovery",
      asOf: "2026-08-18T00:00:00.000Z",
      requestedBy: "live-test",
      maxItems: 10,
    });
    const resumeItem = resumePlan.items.find((item) => item.artifactId === resumeArtifact.id);
    assert.ok(resumeItem);
    await pool.query(
      `update agent_feed.retention_job_items
          set status = 'in_progress', claim_token = gen_random_uuid(), claim_expires_at = now() - interval '1 second'
        where tenant_id = $1 and job_id = $2 and id = $3`, [tenant, resumePlan.id, resumeItem.id],
    );
    let resumedCalls = 0;
    const resumed = await repository.executeRetention(
      { tenantId: tenant, jobId: resumePlan.id, requestedBy: "live-test", confirmationToken: randomBytes(32).toString("base64url") },
      { apply: async (request) => { resumedCalls += 1; assert.equal(request.operationId, retentionOperationId(tenant, resumePlan.id, resumeItem.id)); return { outcome: "already_absent" }; } },
    );
    assert.equal(resumedCalls, 1);
    assert.equal(resumed.job.status, "completed");

    const snapshot = await repository.getSnapshot(tenant, "2026-08-18T00:00:00.000Z");
    assert.equal(snapshot.tenantId, tenant);
    assert.equal(snapshot.liveness, null);
    assert.ok(snapshot.artifactsDeleted >= 2);
    assert.equal((await repository.getSnapshot(otherTenant)).managedArtifacts, 0);

    const sourceRows = await repository.listAuditSources({ tenantId: tenant, limit: 100 });
    assert.ok(sourceRows.length > 0);
    assert.ok(sourceRows.every((row) => row.tenantId === tenant));
    assert.ok(sourceRows.every((row) => !JSON.stringify(row.metadata).includes("payload")));
    assert.ok(sourceRows.every((row, index) => index === 0
      || `${row.occurredAt}\0${row.sourceType}\0${row.sourceId}` >= `${sourceRows[index - 1]!.occurredAt}\0${sourceRows[index - 1]!.sourceType}\0${sourceRows[index - 1]!.sourceId}`));

    const constraints = await pool.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where conname in (
        'managed_artifacts_tenant_id_key', 'retention_jobs_tenant_id_key',
        'retention_job_items_tenant_id_key', 'retention_job_items_tenant_job_fk',
        'retention_job_items_tenant_artifact_fk', 'operations_audit_tenant_id_key',
        'operations_audit_tenant_job_fk', 'operations_audit_tenant_artifact_fk'
      )`,
    );
    assert.equal(constraints.rows.length, 8);
    assert.ok(constraints.rows.every((row) => row.convalidated));
  } finally {
    await pool.end();
  }
});
