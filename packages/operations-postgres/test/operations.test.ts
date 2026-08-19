import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  OperationsError,
  PostgresOperationsRepository,
  mapAuditSourceForOperationsCore,
  retentionOperationId,
  validateConfirmationToken,
  validateMetadata,
  validateStorageReference,
} from "../src/index.ts";
import type { SqlPool } from "../src/types.ts";

const migration = await readFile(new URL("../migrations/0004_operations.sql", import.meta.url), "utf8");

test("the operations migration is additive, tenant-scoped, and does not delete protocol history", () => {
  assert.match(migration, /create\s+table\s+if\s+not\s+exists\s+agent_feed\.managed_artifacts/i);
  assert.match(migration, /legal_hold\s+boolean/i);
  assert.match(migration, /unique\s*\(tenant_id,\s*id\)/i);
  assert.match(migration, /retention_job_items_tenant_job_fk/i);
  assert.match(migration, /retention_job_items_tenant_artifact_fk/i);
  assert.match(migration, /operations_audit_tenant_job_fk/i);
  assert.match(migration, /operations_audit_tenant_artifact_fk/i);
  assert.match(migration, /protect_retention_job/i);
  assert.match(migration, /protect_retention_job_item/i);
  assert.match(migration, /cannot change legal hold while retention deletion is in progress/i);
  assert.match(migration, /storage_ref_opaque_ck/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+agent_feed\.(runs|batches|findings|submitted_evidence|outbox_events|consumer_deliveries|delivery_attempts|acknowledgements|delivery_replays)\b/i);
});

test("storage references and confirmation tokens fail closed", () => {
  assert.equal(validateStorageReference("s3://bucket/recovery/key"), "s3://bucket/recovery/key");
  assert.equal(validateStorageReference("vault:recovery/key"), "vault:recovery/key");
  for (const value of [
    "https://user:password@example.test/object",
    "s3://bucket/object?token=secret",
    "s3://bucket/object#fragment",
    "s3://bucket/object with-space",
  ]) {
    assert.throws(() => validateStorageReference(value), OperationsError);
  }
  const token = randomBytes(32).toString("base64url");
  assert.equal(validateConfirmationToken(token), token);
  assert.throws(() => validateConfirmationToken("replace-with-a-short-token"), /high-entropy/u);
});

test("nested sensitive metadata is rejected and operations-core mapping strips forbidden detail keys", () => {
  assert.deepEqual(validateMetadata({ purpose: "recovery", nested: { count: 2 } }), { purpose: "recovery", nested: { count: 2 } });
  assert.throws(() => validateMetadata({ nested: [{ bearer_token: "do-not-store" }] }), /not permitted/u);
  const mapped = mapAuditSourceForOperationsCore({
    sourceType: "operations.audit",
    sourceId: "audit-1",
    tenantId: "tenant-a",
    occurredAt: "2026-08-18T00:00:00.000Z",
    metadata: {
      artifact_key: "provider-key",
      safe: "keep",
      nested: { artifact_id: "typed-field", access_token: "remove" },
    },
  });
  assert.deepEqual(mapped.metadata, { safe: "keep", nested: {} });
});

test("stable operation IDs make an external retry idempotent", () => {
  const first = retentionOperationId("tenant-a", "job-12345678", "item-12345678");
  const retry = retentionOperationId("tenant-a", "job-12345678", "item-12345678");
  const otherTenant = retentionOperationId("tenant-b", "job-12345678", "item-12345678");
  assert.equal(first, retry);
  assert.notEqual(first, otherTenant);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

type Row = Record<string, unknown>;

class FakePool {
  readonly events: string[] = [];
  readonly values: unknown[][] = [];
  readonly job: Row = {
    id: "job-12345678",
    tenant_id: "tenant-a",
    idempotency_key: "plan-12345678",
    policy_key: "recovery",
    action: "delete",
    as_of: "2026-08-18T00:00:00.000Z",
    requested_by: "operator",
    request_hash: "a".repeat(64),
    max_items: 1,
    status: "planned",
    candidate_count: 1,
    completed_count: 0,
    failed_count: 0,
    created_at: "2026-08-17T00:00:00.000Z",
    started_at: null,
    completed_at: null,
  };
  readonly item: Row = {
    id: "item-12345678",
    artifact_id: "artifact-12345678",
    artifact_key: "recovery-1",
    storage_ref: "s3://bucket/recovery-1",
    artifact_class: "recovery",
    action: "delete",
    expires_at: "2026-08-17T00:00:00.000Z",
    status: "planned",
    claim_expires_at: null,
  };
  legalHold = false;
  inTransaction = false;

  async connect(): Promise<{ query: (text: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>; release: () => void }> {
    return {
      query: (text, values) => this.query(text, values),
      release: () => this.events.push("release"),
    };
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const normalized = text.trim().replace(/\s+/gu, " ");
    this.events.push(normalized);
    this.values.push(values);
    if (normalized === "begin") {
      this.inTransaction = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "commit" || normalized === "rollback") {
      this.inTransaction = false;
      this.events.push(normalized);
      return { rows: [], rowCount: 0 };
    }
    if (/select confirmation_token_hash from agent_feed\.retention_jobs/u.test(normalized)) {
      return { rows: [{ confirmation_token_hash: null }], rowCount: 1 };
    }
    if (/select status, legal_hold/u.test(normalized)) {
      return { rows: [{ status: "active", legal_hold: this.legalHold }], rowCount: 1 };
    }
    if (/select status, claim_expires_at/u.test(normalized)) {
      return { rows: [this.item], rowCount: 1 };
    }
    if (/select id::text, artifact_id::text/u.test(normalized)) {
      return { rows: [this.item], rowCount: 1 };
    }
    if (/select id::text, tenant_id, idempotency_key/u.test(normalized)) {
      return { rows: [this.job], rowCount: 1 };
    }
    if (/update agent_feed\.retention_jobs/u.test(normalized)) {
      if (normalized.includes("status = 'executing'")) this.job.status = "executing";
      else if (values[2] !== undefined) this.job.status = values[2];
      if (typeof values[3] === "number") this.job.completed_count = values[3];
      if (typeof values[4] === "number") this.job.failed_count = values[4];
      return { rows: [], rowCount: 1 };
    }
    if (/update agent_feed\.managed_artifacts/u.test(normalized)) {
      return { rows: [], rowCount: this.legalHold ? 0 : 1 };
    }
    if (/update agent_feed\.retention_job_items/u.test(normalized)) {
      if (normalized.includes("status = 'in_progress'")) {
        this.item.status = "in_progress";
        this.item.claim_expires_at = new Date(Date.now() + 300_000).toISOString();
      }
      if (normalized.includes("status = 'deleted'")) {
        this.item.status = "deleted";
        this.item.claim_expires_at = null;
      }
      if (normalized.includes("status = 'skipped'")) {
        this.item.status = "skipped";
        this.item.claim_expires_at = null;
      }
      if (normalized.includes("status = 'failed'")) {
        this.item.status = "failed";
        this.item.claim_expires_at = null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
}

test("execution commits the claim before adapter I/O, resumes with stable IDs, and never logs the raw token", async () => {
  const pool = new FakePool();
  const repository = new PostgresOperationsRepository(pool as unknown as SqlPool, { maxPlanItems: 10 });
  const token = randomBytes(32).toString("base64url");
  let adapterCalls = 0;
  let adapterTransactionState = true;
  const result = await repository.executeRetention(
    { tenantId: "tenant-a", jobId: "job-12345678", requestedBy: "operator", confirmationToken: token },
    {
      apply: async (request) => {
        adapterCalls += 1;
        adapterTransactionState = pool.inTransaction;
        assert.equal(request.operationId, retentionOperationId("tenant-a", "job-12345678", "item-12345678"));
        assert.equal(request.confirmationToken, token);
        return { outcome: "deleted" };
      },
    },
  );
  assert.equal(adapterCalls, 1);
  assert.equal(adapterTransactionState, false);
  assert.equal(result.job.status, "completed");
  assert.equal(result.completed, 1);
  assert.doesNotMatch(JSON.stringify(pool.values), new RegExp(token, "u"));
  assert.ok(pool.events.findIndex((event) => event === "commit") >= 0);
});

test("a held artifact is skipped before external deletion", async () => {
  const pool = new FakePool();
  pool.legalHold = true;
  const repository = new PostgresOperationsRepository(pool as unknown as SqlPool, { maxPlanItems: 10 });
  const token = randomBytes(32).toString("base64url");
  let adapterCalls = 0;
  const result = await repository.executeRetention(
    { tenantId: "tenant-a", jobId: "job-12345678", requestedBy: "operator", confirmationToken: token },
    { apply: async () => { adapterCalls += 1; return { outcome: "deleted" }; } },
  );
  assert.equal(adapterCalls, 0);
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.items[0]?.status, "skipped");
});

test("concurrent execution claims an in-progress item once", async () => {
  const pool = new FakePool();
  const repository = new PostgresOperationsRepository(pool as unknown as SqlPool, { maxPlanItems: 10 });
  const token = randomBytes(32).toString("base64url");
  let adapterCalls = 0;
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const adapter = {
    apply: async () => {
      adapterCalls += 1;
      enteredResolve?.();
      await release;
      return { outcome: "deleted" as const };
    },
  };
  const first = repository.executeRetention(
    { tenantId: "tenant-a", jobId: "job-12345678", requestedBy: "operator", confirmationToken: token }, adapter,
  );
  await entered;
  const second = repository.executeRetention(
    { tenantId: "tenant-a", jobId: "job-12345678", requestedBy: "operator", confirmationToken: token }, adapter,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseResolve?.();
  await Promise.all([first, second]);
  assert.equal(adapterCalls, 1);
});

test("snapshot and source-query contracts remain bounded and do not claim tenant liveness", async () => {
  const pool = new FakePool();
  const repository = new PostgresOperationsRepository(pool as unknown as SqlPool, { maxPlanItems: 10, maxAuditRows: 10 });
  const snapshot = await repository.getSnapshot("tenant-a", "2026-08-18T00:00:00.000Z");
  assert.equal(snapshot.tenantId, "tenant-a");
  assert.equal(snapshot.liveness, null);
  assert.equal(snapshot.pendingDeliveries, 0);
  await assert.rejects(repository.listAudit({ tenantId: "tenant-a", limit: 11 }), /limit/u);
  await assert.rejects(repository.listAuditSources({ tenantId: "tenant-a", limit: 0 }), /limit/u);
  const sources = await repository.listAuditSources({ tenantId: "tenant-a", limit: 10 });
  assert.deepEqual(sources, []);
  const sourceQuery = pool.events.find((event) => event.includes("with source_rows")) ?? "";
  assert.match(sourceQuery, /from agent_feed\.runs/u);
  assert.match(sourceQuery, /from agent_feed\.submitted_evidence/u);
  assert.match(sourceQuery, /from agent_feed\.delivery_replays/u);
  assert.doesNotMatch(sourceQuery, /from agent_feed\.stream_liveness_incidents/u);
  assert.match(sourceQuery, /order by occurred_at asc, source_type asc, source_id asc/u);
  assert.match(sourceQuery, /limit \$4/u);
});
