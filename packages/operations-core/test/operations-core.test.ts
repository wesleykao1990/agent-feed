import assert from "node:assert/strict";
import test from "node:test";
import {
  exportAudit,
  executeRetentionPlan,
  MAX_AUDIT_EXPORT_BYTES,
  planRetention,
  type AuditRecord,
  type RetentionPlan,
  type RetentionRecord,
  type RetentionStore,
} from "../src/index.ts";

const NOW = "2026-08-18T12:00:00.000Z";

function record(overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  return {
    tenantId: "tenant-a",
    entity: "managed_artifact",
    id: "run-1",
    runId: "run-1",
    streamId: "stream-a",
    createdAt: "2026-08-01T00:00:00.000Z",
    terminalAt: "2026-08-02T00:00:00.000Z",
    status: "completed",
    legalHold: false,
    retainUntil: null,
    ...overrides,
  };
}

function plan(overrides: Partial<RetentionPlan> = {}): RetentionPlan {
  return {
    schemaVersion: "agent-feed.retention-plan.v1",
    planId: "plan-id",
    policyVersion: "retention-2026-01",
    generatedAt: NOW,
    scope: { tenantId: "tenant-a" },
    candidates: [],
    skipped: [],
    ...overrides,
  };
}

test("retention plan is deterministic and sorts candidates independently of input order", () => {
  const policy = {
    policyVersion: "retention-2026-01",
    defaultRule: { ageSeconds: 86_400, requireTerminal: true },
  } as const;
  const input = {
    now: NOW,
    scope: { tenantId: "tenant-a" },
    policy,
    records: [
      record({ id: "artifact-z", runId: "run-z", terminalAt: "2026-08-01T00:00:00.000Z" }),
      record({ id: "artifact-a", runId: "run-a", terminalAt: "2026-08-01T00:00:00.000Z" }),
    ],
  };
  const first = planRetention(input);
  const second = planRetention({ ...input, records: [...input.records].reverse() });
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first.candidates.map((item) => item.id), ["artifact-a", "artifact-z"]);
  assert.equal(first.schemaVersion, "agent-feed.retention-plan.v1");
});

test("retention planning fails explicitly when the candidate limit is exceeded", () => {
  const records = Array.from({ length: 501 }, (_, index) => record({ id: `artifact-${index}` }));
  assert.throws(() => planRetention({
    now: NOW,
    scope: { tenantId: "tenant-a" },
    policy: {
      policyVersion: "retention-2026-01",
      defaultRule: { ageSeconds: 86_400, requireTerminal: true },
    },
    records,
  }), /retention_candidate_limit_exceeded/);
});

test("retention is fail-closed for holds, running records, tenant boundaries, and future expiry", () => {
  const result = planRetention({
    now: NOW,
    scope: { tenantId: "tenant-a", streamIds: ["stream-a"] },
    policy: {
      policyVersion: "retention-2026-01",
      defaultRule: { ageSeconds: 86_400, requireTerminal: true },
    },
    records: [
      record({ id: "hold", legalHold: true }),
      record({ id: "running", terminalAt: null, status: "running" }),
      record({ id: "other-tenant", tenantId: "tenant-b" }),
      record({ id: "other-stream", streamId: "stream-b" }),
      record({ id: "young", terminalAt: "2026-08-18T11:59:59.000Z", retainUntil: "2026-08-19T00:00:00.000Z" }),
      record({ id: "protected-run", entity: "run" }),
    ],
  });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.skipped.map((item) => [item.id, item.reason]), [
    ["hold", "legal_hold"],
    ["other-stream", "outside_scope"],
    ["other-tenant", "tenant_mismatch"],
    ["running", "not_terminal"],
    ["young", "not_expired"],
    ["protected-run", "protected_entity"],
  ]);
});

test("retention honors absolute retain_until and per-entity policies", () => {
  const result = planRetention({
    now: NOW,
    scope: { tenantId: "tenant-a", entities: ["managed_artifact"] },
    policy: {
      policyVersion: "retention-2026-01",
      defaultRule: { ageSeconds: 365 * 86_400, requireTerminal: true },
      rules: { managed_artifact: { ageSeconds: 60, requireTerminal: false } },
    },
    records: [
      record({ id: "artifact-1", runId: "run-1", terminalAt: null, createdAt: "2026-08-18T11:58:00.000Z" }),
      record({ id: "artifact-2", retainUntil: "2026-08-18T11:00:00.000Z" }),
    ],
  });
  assert.deepEqual(result.candidates.map((item) => item.id), ["artifact-2", "artifact-1"]);
  assert.equal(result.candidates[1]?.eligibleAt, "2026-08-18T11:59:00.000Z");
});

test("dry-run never calls the destructive adapter and live execution is tenant-scoped", async () => {
  const calls: unknown[] = [];
  const store: RetentionStore = {
    async listRecords() { return []; },
    async deleteRecords(input) { calls.push(input); return input.candidates.map((candidate) => ({ entity: candidate.entity, id: candidate.id, deleted: true })); },
  };
  const generated = planRetention({
    now: NOW,
    scope: { tenantId: "tenant-a" },
    policy: { policyVersion: "retention-2026-01", defaultRule: { ageSeconds: 86_400, requireTerminal: true } },
    records: [record({ id: "artifact-1" })],
  });
  const candidates = generated.candidates;
  const dry = await executeRetentionPlan(store, generated, { dryRun: true });
  assert.equal(dry.deleted, 0);
  assert.equal(calls.length, 0);
  const live = await executeRetentionPlan(store, generated, { dryRun: false });
  assert.equal(live.deleted, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { tenantId: "tenant-a", planId: generated.planId, candidates });
});

test("core protocol rows are protected even when a caller forges a plan", async () => {
  let deleteCalls = 0;
  const store: RetentionStore = {
    async listRecords() { return []; },
    async deleteRecords() { deleteCalls += 1; return []; },
  };
  const forged = plan({
    candidates: [{
      tenantId: "tenant-a",
      entity: "run",
      id: "run-1",
      runId: "run-1",
      streamId: "stream-a",
      eligibleAt: "2026-08-01T00:00:00.000Z",
      reason: "expired",
    } as never],
  });
  await assert.rejects(() => executeRetentionPlan(store, forged, { dryRun: false }), /retention_protected_entity/);
  assert.equal(deleteCalls, 0);
});

test("execution rejects a tampered managed-artifact plan ID before the adapter", async () => {
  let deleteCalls = 0;
  const store: RetentionStore = {
    async listRecords() { return []; },
    async deleteRecords() { deleteCalls += 1; return []; },
  };
  const generated = planRetention({
    now: NOW,
    scope: { tenantId: "tenant-a" },
    policy: { policyVersion: "retention-2026-01", defaultRule: { ageSeconds: 60, requireTerminal: true } },
    records: [record({ id: "artifact-1" })],
  });
  const tampered = {
    ...generated,
    candidates: generated.candidates.map((candidate) => ({ ...candidate, id: "artifact-attacker" })),
  };
  await assert.rejects(() => executeRetentionPlan(store, tampered, { dryRun: false }), /retention_plan_mismatch/);
  assert.equal(deleteCalls, 0);
});

test("execution rejects duplicate candidates and an over-limit plan before the adapter", async () => {
  let deleteCalls = 0;
  const store: RetentionStore = {
    async listRecords() { return []; },
    async deleteRecords() { deleteCalls += 1; return []; },
  };
  const candidate = { tenantId: "tenant-a", entity: "managed_artifact" as const, id: "artifact-1", runId: null, streamId: null, eligibleAt: "2026-08-01T00:00:00.000Z", reason: "expired" as const };
  await assert.rejects(() => executeRetentionPlan(store, plan({ candidates: [candidate, candidate] }), { dryRun: false }), /retention_duplicate_candidate/);
  const tooMany = Array.from({ length: 501 }, (_, index) => ({ ...candidate, id: `artifact-${index}` }));
  await assert.rejects(() => executeRetentionPlan(store, plan({ candidates: tooMany }), { dryRun: false }), /retention_candidate_limit_exceeded/);
  assert.equal(deleteCalls, 0);
});

test("audit export is metadata-only, tenant-bound, sorted, canonical, and hashed", () => {
  const records: AuditRecord[] = [
    {
      tenantId: "tenant-a",
      recordType: "finding",
      recordId: "finding-2",
      runId: "run-1",
      streamId: "stream-a",
      occurredAt: "2026-08-18T12:00:01+00:00",
      action: "accepted",
      status: "accepted",
      traceId: "trace-1",
      payloadHash: "a".repeat(64),
      details: { source: "untrusted", z: 1, a: true },
    },
    {
      tenantId: "tenant-a",
      recordType: "run",
      recordId: "run-1",
      runId: "run-1",
      streamId: "stream-a",
      occurredAt: "2026-08-18T12:00:00Z",
      action: "completed",
      status: "completed",
      traceId: null,
      payloadHash: null,
    },
  ];
  const result = exportAudit({ scope: { tenantId: "tenant-a" }, records: [...records].reverse() });
  assert.equal(result.recordCount, 2);
  assert.match(result.content, /^\{"action":"completed"/);
  assert.match(result.content, /"details":\{"a":true,"source":"untrusted","z":1\}/);
  assert.equal(result.content.endsWith("\n"), true);
  assert.equal(result.contentSha256.length, 64);
  assert.equal(result.firstOccurredAt, "2026-08-18T12:00:00.000Z");
  assert.equal(result.lastOccurredAt, "2026-08-18T12:00:01.000Z");
});

test("audit ordering uses canonical bytes as a total tie-breaker", () => {
  const tied: AuditRecord[] = [
    {
      tenantId: "tenant-a",
      recordType: "managed_artifact",
      recordId: "artifact-1",
      runId: "run-1",
      streamId: "stream-a",
      occurredAt: NOW,
      action: "retained",
      status: "zeta",
      traceId: null,
      payloadHash: null,
      details: { note: "second" },
    },
    {
      tenantId: "tenant-a",
      recordType: "managed_artifact",
      recordId: "artifact-1",
      runId: "run-1",
      streamId: "stream-a",
      occurredAt: NOW,
      action: "retained",
      status: "alpha",
      traceId: null,
      payloadHash: null,
      details: { note: "first" },
    },
  ];
  const forward = exportAudit({ scope: { tenantId: "tenant-a" }, records: tied });
  const reversed = exportAudit({ scope: { tenantId: "tenant-a" }, records: [...tied].reverse() });
  assert.equal(forward.content, reversed.content);
  assert.equal(forward.contentSha256, reversed.contentSha256);
  assert.equal(forward.recordCount, 2);
  assert.equal(forward.content.indexOf('"status":"alpha"') < forward.content.indexOf('"status":"zeta"'), true);
});

test("audit export rejects cross-tenant records and raw invalid payload hashes", () => {
  const base: AuditRecord = {
    tenantId: "tenant-b",
    recordType: "run",
    recordId: "run-1",
    runId: "run-1",
    streamId: null,
    occurredAt: NOW,
    action: "completed",
    status: "completed",
    traceId: null,
    payloadHash: null,
  };
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-a" }, records: [base] }), /audit_tenant_mismatch/);
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-b" }, records: [{ ...base, payloadHash: "not-a-sha" }] }), /invalid_payload_hash/);
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-b" }, records: [{ ...base, details: { excerpt: "untrusted content" } }] }), /audit_sensitive_detail:excerpt/);
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-b" }, records: [{ ...base, details: { nested: [{ authorizationHeader: "secret" }] } }] }), /audit_sensitive_detail:authorizationHeader/);
});

test("audit export rejects credentials and signed URLs hidden under safe keys", () => {
  const base: AuditRecord = {
    tenantId: "tenant-a",
    recordType: "operator_action",
    recordId: "operator-1",
    runId: null,
    streamId: null,
    occurredAt: NOW,
    action: "exported",
    status: "completed",
    traceId: null,
    payloadHash: null,
  };
  const exportWith = (details: AuditRecord["details"]) => exportAudit({
    scope: { tenantId: "tenant-a" },
    records: [{ ...base, ...(details ? { details } : {}) }],
  });
  assert.throws(() => exportWith({ note: "Bearer abcdefghijklmnopqrstuvwxyz" }), /audit_sensitive_value:authorization_scheme/);
  assert.throws(() => exportWith({ note: "Basic dXNlcjpwYXNzd29yZA==" }), /audit_sensitive_value:authorization_scheme/);
  assert.throws(() => exportWith({ reference: "postgres://audit-user:password@example.test/agent_feed" }), /audit_sensitive_value:url_userinfo/);
  assert.throws(() => exportWith({ reference: "https://storage.example.test/object?X-Amz-Signature=abc123&expires=60" }), /audit_sensitive_value:query_parameter/);
  assert.throws(() => exportWith({ note: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" }), /audit_sensitive_value:openai_api_key/);
});

test("audit export enforces record and byte budgets", () => {
  const base: AuditRecord = {
    tenantId: "tenant-a",
    recordType: "run",
    recordId: "run",
    runId: null,
    streamId: null,
    occurredAt: NOW,
    action: "completed",
    status: "completed",
    traceId: null,
    payloadHash: null,
  };
  const tooMany = Array.from({ length: 1_001 }, (_, index) => ({ ...base, recordId: `run-${index}` }));
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-a" }, records: tooMany }), /audit_export_record_limit_exceeded/);
  const tooLarge = [{ ...base, details: { note: "x".repeat(MAX_AUDIT_EXPORT_BYTES) } }];
  assert.throws(() => exportAudit({ scope: { tenantId: "tenant-a" }, records: tooLarge }), /audit_export_bytes_limit_exceeded/);
});
