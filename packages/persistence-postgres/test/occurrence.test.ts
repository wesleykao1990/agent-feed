import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMisfires,
  decideOverlap,
  type ExpectedOccurrence as CoreExpectedOccurrence,
} from "@agent-feed/occurrence-core";
import {
  OCCURRENCE_LEDGER_MIGRATION_SQL_URL,
  PersistenceError,
  PostgresAgentFeedPersistence,
  PostgresOccurrenceRepository,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../src/index.ts";
import type {
  BeginRunRequest,
  CompleteRunRequest,
  ScheduleExpectationVersionInput,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

test("occurrence migration declares the additive immutable and hardened sidecar", async () => {
  const sql = await readFile(OCCURRENCE_LEDGER_MIGRATION_SQL_URL, "utf8");
  assert.match(sql, /create table if not exists agent_feed\.schedule_expectation_versions/i);
  assert.match(sql, /create table if not exists agent_feed\.expected_occurrences/i);
  assert.match(sql, /create table if not exists agent_feed\.run_occurrence_links/i);
  assert.match(sql, /create table if not exists agent_feed\.run_trigger_contexts/i);
  assert.match(sql, /create table if not exists agent_feed\.schedule_expectation_migration_quarantine/i);
  assert.match(sql, /before update or delete on agent_feed\.run_occurrence_links/i);
  assert.match(sql, /materialize occurrences explicitly/i);
  assert.doesNotMatch(sql, /insert into agent_feed\.expected_occurrences/i);
  assert.doesNotMatch(sql, /insert into agent_feed\.run_occurrence_links/i);
  assert.match(sql, /validate_run_occurrence_link/i);
  assert.match(sql, /run_trigger_contexts/i);
});

function begin(streamId: string, tenantId: string, startedAt: string): BeginRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    idempotency_key: `m7-begin-${randomUUID()}`,
    stream_id: streamId,
    producer: { producer_id: `m7-producer-${tenantId}`, type: "automation", name: "m7-test", version: "1" },
    task: { task_type: "m7-test", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: startedAt,
    parent_run_id: null,
    metadata: {},
    run_id: `m7-run-${randomUUID()}`,
  };
}

function completion(runId: string, tenantId: string, status: CompleteRunRequest["status"], completedAt: string): CompleteRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    run_id: runId,
    idempotency_key: `m7-complete-${randomUUID()}`,
    status,
    completed_at: completedAt,
    actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    errors: status === "completed" ? [] : [{ message: status }],
    metadata: {},
  };
}

function schedule(overrides: Partial<ScheduleExpectationVersionInput> = {}): ScheduleExpectationVersionInput {
  return {
    tenant_id: "m7-tenant",
    schedule_key: `m7-schedule-${randomUUID()}`,
    stream_id: `m7-stream-${randomUUID()}`,
    version: 1,
    schedule_kind: "interval",
    interval_seconds: 3_600,
    cron_expression: null,
    timezone: "UTC",
    anchor_at: "2026-08-20T00:00:00.000Z",
    matching_mode: "explicit",
    misfire_policy: "mark_missed",
    overlap_policy: "allow",
    grace_seconds: 60,
    enabled: true,
    expected_scope: { source_ids: [], subjects: [] },
    owner: "m7-test",
    notes: "",
    ...overrides,
  };
}

async function trusted(
  repository: PostgresOccurrenceRepository,
  runId: string,
  definition: { id: string; schedule_key: string; version: number },
  triggerKind: "scheduled" | "legacy" = "scheduled",
  tenantId = "m7-tenant",
) {
  return repository.recordTrustedRunTriggerContext({
    tenant_id: tenantId,
    run_id: runId,
    trigger_kind: triggerKind,
    schedule_version_id: definition.id,
    trusted_source: "m7-test-adapter",
    metadata: { fixture: true },
  });
}

test("live occurrence repository enforces core materialization, trusted trigger contexts, tenant/stream scope, liveness, append-only rows, and concurrency", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    await migrateAgentFeed(pool);
    const store = new PostgresAgentFeedPersistence(pool);
    const repository = new PostgresOccurrenceRepository(pool);
    const tenantId = "m7-tenant";
    const definition = await repository.createScheduleExpectationVersion(schedule());
    const expected = await repository.materializeScheduleOccurrences({
      tenant_id: tenantId,
      schedule_version_id: definition.id,
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-20T05:00:00.000Z",
    });
    assert.equal(expected.length, 6);
    assert.equal(expected[0]?.window_start, expected[0]?.expected_at);
    assert.equal(new Date(expected[0]!.window_end).getTime() - new Date(expected[0]!.expected_at).getTime(), 60_000);
    assert.deepEqual((await repository.materializeScheduleOccurrences({
      tenant_id: tenantId,
      schedule_key: definition.schedule_key,
      version: 1,
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-20T00:00:00.000Z",
    })).map((item) => item.occurrence_key), [expected[0]!.occurrence_key]);

    const dstDefinition = await repository.createScheduleExpectationVersion(schedule({
      schedule_key: `m7-dst-${randomUUID()}`,
      stream_id: `m7-dst-stream-${randomUUID()}`,
      schedule_kind: "cron",
      interval_seconds: null,
      cron_expression: "30 2 * * *",
      timezone: "America/New_York",
      anchor_at: "2026-03-01T00:00:00.000Z",
    }));
    const dstOccurrences = await repository.materializeScheduleOccurrences({
      tenant_id: tenantId,
      schedule_version_id: dstDefinition.id,
      from: "2026-03-07T00:00:00.000Z",
      to: "2026-03-10T00:00:00.000Z",
    });
    assert.equal(dstOccurrences[0]?.expected_at, "2026-03-07T07:30:00.000Z");
    assert.equal(dstOccurrences[1]?.expected_at, "2026-03-08T07:30:00.000Z");
    assert.equal(dstOccurrences[2]?.expected_at, "2026-03-09T06:30:00.000Z");

    await assert.rejects(
      repository.createExpectedOccurrence({ tenant_id: tenantId, schedule_version_id: definition.id, occurrence_key: "arbitrary", ordinal: 99, expected_at: "2026-08-20T00:00:30.000Z", window_start: "2026-08-20T00:00:30.000Z", window_end: "2026-08-20T00:01:30.000Z" }),
      (error: unknown) => error instanceof PersistenceError && error.code === "occurrence_validation_failed",
    );
    await assert.rejects(
      repository.createExpectedOccurrence({ tenant_id: tenantId, schedule_version_id: definition.id, occurrence_key: expected[0]!.occurrence_key, ordinal: 99, expected_at: expected[0]!.expected_at, window_start: expected[0]!.expected_at, window_end: expected[0]!.expected_at }),
      (error: unknown) => error instanceof PersistenceError && error.code === "occurrence_validation_failed",
    );
    await assert.rejects(
      pool.query(
        `insert into agent_feed.expected_occurrences (
           tenant_id, schedule_version_id, occurrence_key, ordinal,
           expected_at, window_start, window_end
         ) values ($1, $2, 'arbitrary-direct-key', 999,
                   '2026-08-20T06:00:00.000Z', '2026-08-20T06:00:00.000Z',
                   '2026-08-20T06:01:00.000Z')`,
        [tenantId, definition.id],
      ),
      /key does not match/i,
    );

    const running = await store.beginRun(begin(definition.stream_id, tenantId, expected[0]!.expected_at));
    await assert.rejects(
      repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: running.run_id, schedule_version_id: definition.id, occurrence_key: expected[0]!.occurrence_key }),
      (error: unknown) => error instanceof PersistenceError && error.code === "trigger_context_missing",
    );
    await trusted(repository, running.run_id, definition);
    const runningLink = await repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: running.run_id, schedule_version_id: definition.id, occurrence_key: expected[0]!.occurrence_key });
    assert.equal(runningLink.run_id, running.run_id);
    assert.equal((await repository.getOccurrenceLiveness(tenantId, expected[0]!.id, "2026-08-20T00:00:30.000Z"))?.status, "invoked_running");

    const completed = await store.beginRun(begin(definition.stream_id, tenantId, expected[1]!.expected_at));
    await trusted(repository, completed.run_id, definition);
    await repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: completed.run_id, schedule_version_id: definition.id, occurrence_key: expected[1]!.occurrence_key });
    await store.completeRun(completion(completed.run_id, tenantId, "completed", "2026-08-20T01:00:30.000Z"));
    assert.equal((await repository.getOccurrenceLiveness(tenantId, expected[1]!.id, "2026-08-20T02:00:00.000Z"))?.status, "satisfied");

    for (const [index, status] of [[2, "partial"], [3, "failed"], [4, "cancelled"]] as const) {
      const run = await store.beginRun(begin(definition.stream_id, tenantId, expected[index]!.expected_at));
      await trusted(repository, run.run_id, definition);
      await repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: run.run_id, schedule_version_id: definition.id, occurrence_key: expected[index]!.occurrence_key });
      await store.completeRun(completion(run.run_id, tenantId, status, new Date(new Date(expected[index]!.expected_at).getTime() + 30_000).toISOString()));
    }
    assert.equal((await repository.getOccurrenceLiveness(tenantId, expected[2]!.id, "2026-08-20T05:00:00.000Z"))?.status, "invoked_partial");
    assert.equal((await repository.getOccurrenceLiveness(tenantId, expected[3]!.id, "2026-08-20T05:00:00.000Z"))?.status, "invoked_failed");
    assert.equal((await repository.getOccurrenceLiveness(tenantId, expected[4]!.id, "2026-08-20T05:00:00.000Z"))?.status, "invoked_cancelled");

    const manual = await store.beginRun(begin(definition.stream_id, tenantId, expected[5]!.expected_at));
    await repository.recordTrustedRunTriggerContext({ tenant_id: tenantId, run_id: manual.run_id, trigger_kind: "manual", trusted_source: "m7-test-adapter", metadata: {} });
    await assert.rejects(
      repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: manual.run_id, schedule_version_id: definition.id, occurrence_key: expected[5]!.occurrence_key }),
      (error: unknown) => error instanceof PersistenceError && error.code === "invalid_trigger_kind",
    );
    for (const triggerKind of ["test", "retry", "replay", "backfill", "event", "unknown"] as const) {
      const nonScheduled = await store.beginRun(begin(definition.stream_id, tenantId, expected[5]!.expected_at));
      await repository.recordTrustedRunTriggerContext({ tenant_id: tenantId, run_id: nonScheduled.run_id, trigger_kind: triggerKind, trusted_source: "m7-test-adapter", metadata: {} });
      await assert.rejects(
        repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: nonScheduled.run_id, schedule_version_id: definition.id, occurrence_key: expected[5]!.occurrence_key }),
        (error: unknown) => error instanceof PersistenceError && error.code === "invalid_trigger_kind",
      );
    }
    assert.equal((await repository.listOccurrenceLiveness({ tenant_id: tenantId, schedule_version_id: definition.id, now: "2026-08-20T06:00:00.000Z" })).filter((item) => item.status === "absent").length, 1);
    const persistedOccurrences = await repository.listExpectedOccurrences({ tenant_id: tenantId, schedule_version_id: definition.id });
    const persistedLinks = await repository.listRunOccurrenceLinks(tenantId);
    const coreOccurrences: CoreExpectedOccurrence[] = persistedOccurrences.map((item) => ({
      schemaVersion: "agent-feed.expected-occurrence.v1",
      occurrenceKey: item.occurrence_key,
      expectationId: item.schedule_version_id,
      expectationVersion: String(item.version),
      expectedAt: item.expected_at,
      nominalAt: item.expected_at,
      windowEndsAt: item.window_end,
      graceSeconds: definition.grace_seconds,
    }));
    const misfire = classifyMisfires({
      policy: definition.misfire_policy,
      occurrences: coreOccurrences,
      now: "2026-08-20T06:02:00.000Z",
      linkedOccurrenceKeys: persistedLinks.map((item) => item.occurrence_key),
    });
    assert.equal(misfire.missed.length, 1);
    assert.equal(misfire.missed[0]?.occurrenceKey, expected[5]?.occurrence_key);
    assert.equal(misfire.linked.length, 5);
    const runningLiveness = await repository.getOccurrenceLiveness(tenantId, expected[0]!.id, "2026-08-20T06:02:00.000Z");
    if (runningLiveness?.run_status !== "running") assert.fail("persisted running invocation was not preserved");
    const priorInvocations = [{ runId: running.run_id, status: runningLiveness.run_status }] as const;
    assert.equal(decideOverlap({ policy: "skip", priorInvocations }).decision, "suppressed");
    assert.equal(decideOverlap({ policy: "fail_closed", priorInvocations }).decision, "conflict");
    assert.equal(await repository.getExpectedOccurrence("other-tenant", expected[0]!.id), null);
    await assert.rejects(pool.query("update agent_feed.expected_occurrences set occurrence_key = 'tampered' where tenant_id = $1 and id = $2", [tenantId, expected[0]!.id]), /append-only/i);
    await assert.rejects(pool.query("update agent_feed.run_trigger_contexts set trusted_source = 'tampered' where tenant_id = $1 and id = (select id from agent_feed.run_trigger_contexts where tenant_id = $1 limit 1)", [tenantId]), /append-only/i);

    const duplicateOccurrence = expected[5]!;
    const oneRun = await store.beginRun(begin(definition.stream_id, tenantId, duplicateOccurrence.expected_at));
    const otherRun = await store.beginRun(begin(definition.stream_id, tenantId, duplicateOccurrence.expected_at));
    await trusted(repository, oneRun.run_id, definition);
    await trusted(repository, otherRun.run_id, definition);
    const duplicateResults = await Promise.allSettled([
      repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: oneRun.run_id, schedule_version_id: definition.id, occurrence_id: duplicateOccurrence.id }),
      repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: otherRun.run_id, schedule_version_id: definition.id, occurrence_id: duplicateOccurrence.id }),
    ]);
    assert.equal(duplicateResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(duplicateResults.filter((result) => result.status === "rejected").length, 1);

    const windowed = await repository.createScheduleExpectationVersion(schedule({ schedule_key: `m7-window-${randomUUID()}`, stream_id: `m7-window-stream-${randomUUID()}`, matching_mode: "windowed" }));
    const windowedOccurrences = await repository.materializeScheduleOccurrences({ tenant_id: tenantId, schedule_version_id: windowed.id, from: "2026-08-20T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z" });
    const windowedRun = await store.beginRun(begin(windowed.stream_id, tenantId, windowedOccurrences[0]!.expected_at));
    await trusted(repository, windowedRun.run_id, windowed);
    await repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: windowedRun.run_id, schedule_version_id: windowed.id });
    assert.equal((await repository.getOccurrenceLiveness(tenantId, windowedOccurrences[0]!.id, windowedOccurrences[0]!.expected_at))?.status, "invoked_running");

    const legacyDefinition = await repository.createScheduleExpectationVersion(schedule({
      schedule_key: `m7-legacy-${randomUUID()}`,
      stream_id: `m7-legacy-stream-${randomUUID()}`,
      matching_mode: "legacy",
    }));
    const legacyOccurrences = await repository.materializeScheduleOccurrences({ tenant_id: tenantId, schedule_version_id: legacyDefinition.id, from: "2026-08-20T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z" });
    const legacyRun = await store.beginRun(begin(legacyDefinition.stream_id, tenantId, legacyOccurrences[0]!.expected_at));
    await trusted(repository, legacyRun.run_id, legacyDefinition, "legacy");
    const legacyLink = await repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: legacyRun.run_id, schedule_version_id: legacyDefinition.id });
    assert.equal(legacyLink.trigger_kind, "legacy");

    const ambiguous = await repository.createScheduleExpectationVersion(schedule({ schedule_key: `m7-ambiguous-${randomUUID()}`, stream_id: `m7-ambiguous-stream-${randomUUID()}`, matching_mode: "windowed", grace_seconds: 7_200 }));
    const ambiguousOccurrences = await repository.materializeScheduleOccurrences({ tenant_id: tenantId, schedule_version_id: ambiguous.id, from: "2026-08-21T01:00:00.000Z", to: "2026-08-21T02:00:00.000Z" });
    assert.equal(ambiguousOccurrences.length, 2);
    const ambiguousRun = await store.beginRun(begin(ambiguous.stream_id, tenantId, "2026-08-21T02:30:00.000Z"));
    await trusted(repository, ambiguousRun.run_id, ambiguous);
    await assert.rejects(repository.linkRunToOccurrence({ tenant_id: tenantId, run_id: ambiguousRun.run_id, schedule_version_id: ambiguous.id }), (error: unknown) => error instanceof PersistenceError && error.code === "ambiguous_occurrence");
    const outsideRun = await store.beginRun(begin(ambiguous.stream_id, tenantId, "2026-08-21T05:00:00.000Z"));
    await trusted(repository, outsideRun.run_id, ambiguous);
    await assert.rejects(
      pool.query(`insert into agent_feed.run_occurrence_links (tenant_id, schedule_version_id, occurrence_id, run_id, trigger_kind, matching_mode, matched_at, metadata) values ($1, $2, $3, (select id from agent_feed.runs where tenant_id = $1 and wire_run_id = $4), 'scheduled', 'windowed', now(), '{}'::jsonb)`, [tenantId, ambiguous.id, ambiguousOccurrences[0]!.id, outsideRun.run_id]),
      /outside the occurrence window/i,
    );

    const conflictRun = await store.beginRun(begin(definition.stream_id, tenantId, expected[5]!.expected_at));
    const firstContext = await trusted(repository, conflictRun.run_id, definition);
    assert.equal((await repository.recordTrustedRunTriggerContext({ tenant_id: tenantId, run_id: conflictRun.run_id, trigger_kind: "scheduled", schedule_version_id: definition.id, trusted_source: "m7-test-adapter", metadata: { fixture: true } })).id, firstContext.id);
    await assert.rejects(repository.recordTrustedRunTriggerContext({ tenant_id: tenantId, run_id: conflictRun.run_id, trigger_kind: "manual", trusted_source: "m7-test-adapter", metadata: {} }), (error: unknown) => error instanceof PersistenceError && error.code === "trigger_context_conflict");

    const mismatchedRun = await store.beginRun(begin(`m7-other-stream-${randomUUID()}`, tenantId, expected[5]!.expected_at));
    await assert.rejects(trusted(repository, mismatchedRun.run_id, definition), (error: unknown) => error instanceof PersistenceError && error.code === "stream_mismatch");

    await assert.rejects(repository.createScheduleExpectationVersion(schedule({ schedule_kind: "cron", interval_seconds: null, cron_expression: "0 0 1 1 ?", stream_id: `m7-cron-stream-${randomUUID()}` })), (error: unknown) => error instanceof PersistenceError && error.code === "invalid_input");
    await assert.rejects(pool.query(`insert into agent_feed.schedule_expectation_versions (tenant_id, schedule_key, stream_id, version, schedule_kind, interval_seconds, cron_expression, timezone, anchor_at, matching_mode, misfire_policy, overlap_policy, grace_seconds, enabled, expected_scope, owner) values ('m7-tenant', $1, $2, 1, 'cron', null, '0 0 1 1 ?', 'UTC', now(), 'explicit', 'mark_missed', 'allow', 0, true, '{}'::jsonb, 'm7-test')`, [`m7-direct-cron-${randomUUID()}`, `m7-direct-stream-${randomUUID()}`]), /cron|check|constraint/i);

    const legacyStream = `m7-legacy-migration-${randomUUID()}`;
    await store.registerStreamExpectation({ stream_id: legacyStream, expected_cadence_seconds: 3_600, grace_seconds: 10, enabled: true, expected_scope: { source_ids: [], subjects: [] }, owner: "m7-test", notes: "legacy fixture" });
    const nonDefault = await store.beginRun(begin(legacyStream, "m7-nondefault", "2026-08-22T00:00:00.000Z"));
    await migrateAgentFeed(pool);
    assert.equal(await repository.getScheduleExpectationVersion("default", legacyStream, 1), null);
    assert.equal((await repository.listMigrationQuarantine()).some((item) => item.stream_id === legacyStream), true);
    assert.equal(nonDefault.tenant_id, "m7-nondefault");
  } finally {
    await pool.end();
  }
});
