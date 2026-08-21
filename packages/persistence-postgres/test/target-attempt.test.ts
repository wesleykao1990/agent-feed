import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import {
  TARGET_ATTEMPT_LEDGER_MIGRATION_SQL_URL,
  PersistenceError,
  PostgresAgentFeedPersistence,
  PostgresTargetAttemptRepository,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../src/index.ts";
import type { BeginRunRequest, TargetAttemptInput } from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const DIGEST = "a".repeat(64);

test("target-attempt migration declares an additive append-only projection ledger", async () => {
  const sql = await readFile(TARGET_ATTEMPT_LEDGER_MIGRATION_SQL_URL, "utf8");
  assert.match(sql, /create table if not exists agent_feed\.target_attempts/i);
  assert.match(sql, /create table if not exists agent_feed\.target_attempt_run_deployments/i);
  assert.match(sql, /unique \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /unique \(tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number\)/i);
  assert.match(sql, /foreign key \(tenant_id, job_deployment_id\)/i);
  assert.match(sql, /before update or delete on agent_feed\.target_attempts/i);
  assert.match(sql, /before truncate on agent_feed\.target_attempts/i);
  assert.match(sql, /create or replace view agent_feed\.target_attempt_latest/i);
  assert.match(sql, /create or replace view agent_feed\.target_attempt_last_resolved/i);
  assert.match(sql, /'validation_rejected'/i);
  assert.match(sql, /locator_reference/i);
});

function begin(tenantId: string, runId: string): BeginRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    idempotency_key: `target-ledger-begin-${randomUUID()}`,
    stream_id: `target-ledger-stream-${randomUUID()}`,
    producer: { producer_id: "target-ledger-test", type: "automation", name: "target-ledger-test", version: "1" },
    task: { task_type: "target-ledger-test", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-22T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    run_id: runId,
  };
}

function attempt(overrides: Partial<TargetAttemptInput> = {}): TargetAttemptInput {
  return {
    tenant_id: "target-ledger-tenant",
    job_deployment_id: "00000000-0000-4000-8000-000000000001",
    run_id: "target-ledger-run-1",
    work_unit_id: "unit-1",
    target_id: "target-1",
    attempt_number: 1,
    idempotency_key: "target-ledger-attempt-1",
    input_digest: DIGEST,
    outcome: "resolved",
    locator_digest: null,
    locator_reference: "https://example.test/path",
    accepted_finding_count: 1,
    accepted_evidence_count: 1,
    attempted_at: "2026-08-22T00:01:00.000Z",
    ...overrides,
  };
}

test("live target-attempt repository preserves exact retries, monotone attempts, and last resolution", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    const store = new PostgresAgentFeedPersistence(pool);
    const repository = new PostgresTargetAttemptRepository(pool);
    const tenantId = `target-ledger-tenant-${randomUUID()}`;
    const runId = `target-ledger-run-${randomUUID()}`;
    await store.beginRun(begin(tenantId, runId));
    const definition = await store.jobRegistry.createJobDefinitionVersion({
      tenant_id: tenantId,
      definition: {
        jobKey: `target-ledger-job-${randomUUID()}`, version: 1, ownerId: "target-ledger-test",
        lifecycleState: "draft", instructions: { digest: DIGEST, controlledReference: "git+https://example.test/target-ledger" },
        validationPolicyVersionId: null, requiredCapabilities: [], outputContracts: [], budgets: [], metadata: {},
      },
    });
    const deployment = await store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: tenantId, binding_key: `target-ledger-deployment-${randomUUID()}`, version: 1,
      job_definition_version_id: definition.id, activation_state: "shadow",
      topology: { schedulerProvider: "target-ledger", executorProvider: "target-ledger", ingressKind: "manual_export" },
      capability_profile_version_ids: [], off_switch_reference: null, shadow_assessment_ids: [],
    });
    const otherDeployment = await store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: tenantId, binding_key: `target-ledger-other-deployment-${randomUUID()}`, version: 1,
      job_definition_version_id: definition.id, activation_state: "shadow",
      topology: { schedulerProvider: "target-ledger", executorProvider: "target-ledger", ingressKind: "manual_export" },
      capability_profile_version_ids: [], off_switch_reference: null, shadow_assessment_ids: [],
    });

    const firstInput = attempt({ tenant_id: tenantId, job_deployment_id: deployment.id, run_id: runId, idempotency_key: `target-ledger-attempt-${randomUUID()}` });
    const first = await repository.appendTargetAttempt(firstInput);
    assert.equal(first.appended, true);
    assert.equal(first.projection.latest?.outcome, "resolved");
    assert.equal(first.projection.last_resolved?.attempt_number, 1);

    const replay = await repository.appendTargetAttempt({ ...firstInput });
    assert.equal(replay.appended, false);
    assert.deepEqual(replay.attempt, first.attempt);

    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, input_digest: "b".repeat(64) }),
      (error: unknown) => error instanceof PersistenceError && error.code === "idempotency_payload_conflict",
    );
    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, idempotency_key: `target-ledger-gap-${randomUUID()}`, attempt_number: 3 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input",
    );
    const second = await repository.appendTargetAttempt({ ...firstInput, idempotency_key: `target-ledger-access-${randomUUID()}`, attempt_number: 2, outcome: "access", accepted_finding_count: 0, accepted_evidence_count: 0, attempted_at: "2026-08-22T00:02:00.000Z" });
    assert.equal(second.projection.latest?.outcome, "access");
    assert.equal(second.projection.last_resolved?.outcome, "resolved");
    const third = await repository.appendTargetAttempt({ ...firstInput, idempotency_key: `target-ledger-timeout-${randomUUID()}`, attempt_number: 3, outcome: "timeout", accepted_finding_count: 0, accepted_evidence_count: 0, attempted_at: "2026-08-22T00:03:00.000Z" });
    assert.equal(third.projection.latest?.outcome, "timeout");
    assert.equal(third.projection.last_resolved?.outcome, "resolved");

    const extra = { ...firstInput, idempotency_key: `target-ledger-extra-${randomUUID()}`, attempt_number: 3, extra: true } as TargetAttemptInput & { extra: boolean };
    await assert.rejects(repository.appendTargetAttempt(extra), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");
    const accessor = { ...firstInput, idempotency_key: `target-ledger-accessor-${randomUUID()}`, attempt_number: 3 } as TargetAttemptInput & { get extra(): boolean };
    Object.defineProperty(accessor, "extra", { get: () => true, enumerable: true });
    await assert.rejects(repository.appendTargetAttempt(accessor), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");
    const proxied = new Proxy({ ...firstInput, idempotency_key: `target-ledger-proxy-${randomUUID()}`, attempt_number: 3 }, {});
    await assert.rejects(repository.appendTargetAttempt(proxied), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");

    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, tenant_id: `wrong-${randomUUID()}`, idempotency_key: `target-ledger-wrong-tenant-${randomUUID()}`, attempt_number: 1 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "run_not_found",
    );
    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, job_deployment_id: "00000000-0000-4000-8000-000000000001", idempotency_key: `target-ledger-unregistered-${randomUUID()}`, attempt_number: 1 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input",
    );
    const otherTenant = `target-ledger-other-${randomUUID()}`;
    const otherRunId = `target-ledger-other-run-${randomUUID()}`;
    await store.beginRun(begin(otherTenant, otherRunId));
    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, tenant_id: otherTenant, run_id: otherRunId, idempotency_key: `target-ledger-cross-tenant-${randomUUID()}`, attempt_number: 1 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input",
    );
    await assert.rejects(
      repository.appendTargetAttempt({ ...firstInput, job_deployment_id: otherDeployment.id, idempotency_key: `target-ledger-switch-${randomUUID()}`, attempt_number: 1 }),
      (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input",
    );
    await assert.rejects(pool.query("update agent_feed.target_attempts set outcome = 'resolved' where id = $1", [first.attempt.id]), /append-only/i);
    await assert.rejects(pool.query("delete from agent_feed.target_attempts where id = $1", [first.attempt.id]), /append-only/i);
    await assert.rejects(pool.query("truncate agent_feed.target_attempts"), /append-only/i);
  } finally {
    await pool.end();
  }
});

test("target-attempt preflight rejects proxies, symbols, hidden/accessor fields, and extras before pool checkout", async () => {
  let connects = 0;
  let queries = 0;
  const pool = {
    connect: async () => { connects += 1; throw new Error("pool checkout must not happen"); },
    query: async () => { queries += 1; throw new Error("pool query must not happen"); },
  } as unknown as Pool;
  const repository = new PostgresTargetAttemptRepository(pool);
  const hostile = [
    { ...attempt(), extra: true },
    Object.defineProperty({ ...attempt(), idempotency_key: "target-ledger-hidden" }, "hidden", { value: true, enumerable: false }),
    Object.defineProperty({ ...attempt(), idempotency_key: "target-ledger-accessor" }, "extra", { get: () => true, enumerable: true }),
    Object.defineProperty({ ...attempt(), idempotency_key: "target-ledger-symbol" }, Symbol("extra"), { value: true, enumerable: true }),
    new Proxy({ ...attempt(), idempotency_key: "target-ledger-proxy" }, {}),
  ];
  for (const input of hostile) await assert.rejects(repository.appendTargetAttempt(input as TargetAttemptInput), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");
  await assert.rejects(repository.listTargetAttempts(new Proxy({ job_deployment_id: attempt().job_deployment_id, run_id: attempt().run_id }, {})), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");
  assert.equal(connects, 0);
  assert.equal(queries, 0);
});

test("target-attempt transaction failures pass the original error to client.release", async () => {
  const original = new Error("synthetic query failure");
  let releaseArguments = 0;
  let releasedError: unknown;
  const fakeClient = {
    query: async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      throw original;
    },
    release: (error?: unknown) => { releaseArguments += 1; releasedError = error; },
  };
  const pool = { connect: async () => fakeClient } as unknown as Pool;
  const repository = new PostgresTargetAttemptRepository(pool);
  await assert.rejects(repository.appendTargetAttempt(attempt()), (error: unknown) => error instanceof PersistenceError && error.code === "storage_error");
  assert.equal(releaseArguments, 1);
  assert.equal(releasedError, original);
});
