import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteAgentFeedStore, SqlitePersistenceError, canonicalJson, payloadHash } from "../index.mjs";

function begin(overrides = {}) {
  return {
    protocol_version: "0.1",
    idempotency_key: "begin-sqlite-001",
    stream_id: "demo.stream",
    producer: { producer_id: "producer.sqlite", type: "automation", name: "sqlite-test", version: "1" },
    task: { task_type: "test", definition_id: null, definition_version: null },
    expected_scope: { source_ids: ["source-1"], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    ...overrides,
  };
}

function evidence(id) {
  return {
    evidence_id: id,
    kind: "web",
    source: { uri: "https://example.invalid/source", title: "Synthetic", publisher: "Test", source_id: "source-1" },
    captured_at: "2026-08-18T00:00:01.000Z",
    published_at: null,
    locator: null,
    excerpt: "bounded fixture evidence",
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
    metadata: {},
  };
}

function finding(id, evidenceId) {
  return {
    finding_id: id,
    finding_type: "synthetic.test",
    title: "Synthetic finding",
    summary: "A finding used by the SQLite reference test.",
    subjects: [{ type: "test", id: "subject-1" }],
    effective_time: { occurred_at: null, effective_from: null, effective_to: null },
    assessment: { novelty: "new", source_authority_claim: "unknown", evidence_completeness: "complete", agent_confidence: 0.5 },
    evidence_refs: [evidenceId],
    producer_dedupe_key: null,
    routing_tags: ["test"],
    attributes: { synthetic: true },
    security_flags: [],
  };
}

function batch(runId, overrides = {}) {
  return {
    protocol_version: "0.1",
    run_id: runId,
    batch_id: "batch-sqlite-001",
    idempotency_key: "batch-sqlite-001",
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [finding("finding-sqlite-001", "evidence-sqlite-001")],
    evidence: [evidence("evidence-sqlite-001")],
    metadata: {},
    ...overrides,
  };
}

function complete(runId, overrides = {}) {
  return {
    protocol_version: "0.1",
    run_id: runId,
    idempotency_key: "complete-sqlite-001",
    status: "completed",
    completed_at: "2026-08-18T00:00:02.000Z",
    actual_scope: { source_ids: ["source-1"], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 1, batches_submitted: 1 },
    errors: [],
    metadata: {},
    ...overrides,
  };
}

function store() {
  return new SqliteAgentFeedStore();
}

test("canonical hashes are order independent and fail closed for undefined", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ invalid: undefined }), /json_undefined/u);
});

test("begin, batch, and complete lifecycle is durable and exact retries are idempotent", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_001" }));
    assert.equal(started.status, "running");
    assert.equal(feed.beginRun(begin({ run_id: "run_sqlite_001" })).run_id, started.run_id);
    const accepted = feed.submitBatch(batch(started.run_id));
    assert.equal(accepted.batches.length, 1);
    assert.equal(accepted.findings.length, 1);
    assert.equal(accepted.evidence.length, 1);
    assert.deepEqual(feed.submitBatch(batch(started.run_id)).stats, accepted.stats);
    const completed = feed.completeRun(complete(started.run_id));
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.stats, { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 1, batches_submitted: 1 });
    assert.equal(feed.completeRun(complete(started.run_id)).status, "completed");
    assert.equal(feed.getRunForTenant("default", started.run_id)?.status, "completed");
  } finally {
    feed.close();
  }
});

test("payload drift and terminal writes fail closed without mutating accepted state", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_002" }));
    feed.submitBatch(batch(started.run_id));
    assert.throws(() => feed.beginRun(begin({ run_id: "run_sqlite_002", metadata: { drifted: true } })), (error) => error instanceof SqlitePersistenceError && error.code === "idempotency_payload_conflict");
    assert.throws(() => feed.submitBatch(batch(started.run_id, { metadata: { drifted: true } })), (error) => error instanceof SqlitePersistenceError && error.code === "idempotency_payload_conflict");
    feed.completeRun(complete(started.run_id));
    assert.throws(() => feed.submitBatch(batch(started.run_id, { batch_id: "batch-after-terminal", idempotency_key: "batch-after-terminal", sequence_number: 2 })), (error) => error instanceof SqlitePersistenceError && error.code === "terminal_run_immutable");
    assert.throws(() => feed.completeRun(complete(started.run_id, { idempotency_key: "complete-after-terminal" })), (error) => error instanceof SqlitePersistenceError && error.code === "terminal_run_immutable");
    assert.equal(feed.getRun("default", started.run_id)?.batches.length, 1);
  } finally {
    feed.close();
  }
});

test("batch invariants reject duplicate IDs, non-increasing sequences, and unresolved evidence atomically", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_003" }));
    assert.throws(() => feed.submitBatch(batch(started.run_id, { findings: [finding("finding-missing", "missing-evidence")], evidence: [] })), (error) => error instanceof SqlitePersistenceError && error.code === "unresolved_evidence_ref");
    assert.equal(feed.getRun("default", started.run_id)?.batches.length, 0);
    feed.submitBatch(batch(started.run_id));
    assert.throws(() => feed.submitBatch(batch(started.run_id, { batch_id: "batch-sqlite-002", idempotency_key: "batch-sqlite-002", sequence_number: 1, findings: [], evidence: [evidence("evidence-sqlite-002")] })), (error) => error instanceof SqlitePersistenceError && error.code === "batch_sequence_not_increasing");
    assert.throws(() => feed.submitBatch(batch(started.run_id, { batch_id: "batch-sqlite-003", idempotency_key: "batch-sqlite-003", sequence_number: 2, findings: [finding("finding-sqlite-001", "evidence-sqlite-002")], evidence: [evidence("evidence-sqlite-002")] })), (error) => error instanceof SqlitePersistenceError && error.code === "duplicate_finding");
    assert.equal(feed.getRun("default", started.run_id)?.batches.length, 1);
  } finally {
    feed.close();
  }
});

test("completion requires accepted counts, valid time, and scope statistics", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_004" }));
    assert.throws(() => feed.completeRun(complete(started.run_id, { stats: { sources_attempted: 0, sources_succeeded: 1, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 } })), (error) => error instanceof SqlitePersistenceError && error.code === "invalid_scope_stats");
    assert.throws(() => feed.completeRun(complete(started.run_id, { stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 0, batches_submitted: 0 } })), (error) => error instanceof SqlitePersistenceError && error.code === "completion_counts_do_not_reconcile");
    assert.throws(() => feed.completeRun(complete(started.run_id, { completed_at: "2026-08-17T23:59:59.000Z", stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 } })), (error) => error instanceof SqlitePersistenceError && error.code === "completion_before_start");
    assert.equal(feed.getRun("default", started.run_id)?.status, "running");
  } finally {
    feed.close();
  }
});

test("SQLite append-only triggers protect accepted rows and terminal identity", () => {
  const database = new DatabaseSync(":memory:");
  const feed = new SqliteAgentFeedStore({ database });
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_005" }));
    const internal = database.prepare("select internal_id from runs where wire_run_id = ?").get(started.run_id).internal_id;
    assert.throws(() => database.prepare("update runs set stream_id = 'tampered' where internal_id = ?").run(internal), /immutable/u);
    feed.submitBatch(batch(started.run_id));
    const batchInternal = database.prepare("select id from batches where run_internal_id = ?").get(internal).id;
    assert.throws(() => database.prepare("delete from batches where id = ?").run(batchInternal), /immutable/u);
  } finally {
    feed.close();
    database.close();
  }
});

test("tenant-scoped reads do not cross the lifecycle boundary", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_tenant", tenant_id: "tenant_a" }));
    assert.equal(feed.getRunForTenant("tenant_b", started.run_id), null);
    assert.equal(feed.listRuns({ tenant_id: "tenant_b" }).length, 0);
    assert.equal(feed.listRuns({ tenant_id: "tenant_a" }).length, 1);
  } finally {
    feed.close();
  }
});

test("wire run IDs may collide across tenants, but every read requires the tenant scope", () => {
  const feed = store();
  try {
    const wireRunId = "run_shared_wire_id";
    const first = feed.beginRun(begin({ tenant_id: "tenant_a", run_id: wireRunId, idempotency_key: "begin-tenant-a" }));
    const second = feed.beginRun(begin({ tenant_id: "tenant_b", run_id: wireRunId, idempotency_key: "begin-tenant-b" }));
    assert.equal(first.run_id, second.run_id);
    assert.equal(feed.getRun("tenant_a", wireRunId)?.tenant_id, "tenant_a");
    assert.equal(feed.getRun("tenant_b", wireRunId)?.tenant_id, "tenant_b");
    assert.throws(() => feed.getRun(wireRunId), (error) => error instanceof SqlitePersistenceError && error.code === "invalid_input");
    assert.throws(() => feed.listRuns(), (error) => error instanceof SqlitePersistenceError && error.code === "invalid_input");
    assert.equal(feed.listRuns({ tenant_id: "tenant_a" }).length, 1);
    assert.equal(feed.listRuns({ tenant_id: "tenant_b" }).length, 1);
  } finally {
    feed.close();
  }
});

test("terminal SQL updates must reconcile envelope identity, source stats, accepted counts, and scope", () => {
  const database = new DatabaseSync(":memory:");
  const feed = new SqliteAgentFeedStore({ database });
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_trigger_guard" }));
    const internal = database.prepare("select internal_id from runs where wire_run_id = ? and tenant_id = 'default'").get(started.run_id).internal_id;
    const currentEnvelope = JSON.parse(database.prepare("select envelope_json from runs where internal_id = ?").get(internal).envelope_json);
    const terminalColumns = {
      status: "completed",
      completed_at: "2026-08-18T00:00:02.000Z",
      actual_scope_json: JSON.stringify({ source_ids: [], subjects: [], queries: [], metadata: {} }),
      complete_idempotency_key: "forged-complete-001",
      complete_payload_hash: "forged-hash-001",
      sources_attempted: 0,
      sources_succeeded: 0,
    };
    assert.throws(
      () => database.prepare(`update runs set status = ?, envelope_json = ?, completed_at = ?, actual_scope_json = ?,
        complete_idempotency_key = ?, complete_payload_hash = ?, sources_attempted = ?, sources_succeeded = ? where internal_id = ?`).run(
        terminalColumns.status, "{not-json", terminalColumns.completed_at, terminalColumns.actual_scope_json,
        terminalColumns.complete_idempotency_key, terminalColumns.complete_payload_hash,
        terminalColumns.sources_attempted, terminalColumns.sources_succeeded, internal,
      ),
      /valid JSON/u,
    );

    const identityForgery = {
      ...currentEnvelope,
      run_id: "run_forged_wire_id",
      status: terminalColumns.status,
      completed_at: terminalColumns.completed_at,
      actual_scope: JSON.parse(terminalColumns.actual_scope_json),
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    };
    assert.throws(
      () => database.prepare(`update runs set status = ?, envelope_json = ?, completed_at = ?, actual_scope_json = ?,
        complete_idempotency_key = ?, complete_payload_hash = ?, sources_attempted = ?, sources_succeeded = ? where internal_id = ?`).run(
        terminalColumns.status, JSON.stringify(identityForgery), terminalColumns.completed_at, terminalColumns.actual_scope_json,
        terminalColumns.complete_idempotency_key, terminalColumns.complete_payload_hash,
        terminalColumns.sources_attempted, terminalColumns.sources_succeeded, internal,
      ),
      /immutable columns/u,
    );

    feed.submitBatch(batch(started.run_id));
    const countForgery = {
      ...currentEnvelope,
      status: terminalColumns.status,
      completed_at: terminalColumns.completed_at,
      actual_scope: JSON.parse(terminalColumns.actual_scope_json),
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    };
    assert.throws(
      () => database.prepare(`update runs set status = ?, envelope_json = ?, completed_at = ?, actual_scope_json = ?,
        complete_idempotency_key = ?, complete_payload_hash = ?, sources_attempted = ?, sources_succeeded = ? where internal_id = ?`).run(
        terminalColumns.status, JSON.stringify(countForgery), terminalColumns.completed_at, terminalColumns.actual_scope_json,
        terminalColumns.complete_idempotency_key, terminalColumns.complete_payload_hash,
        terminalColumns.sources_attempted, terminalColumns.sources_succeeded, internal,
      ),
      /statistics do not reconcile/u,
    );
    assert.equal(feed.getRun("default", started.run_id)?.status, "running");
  } finally {
    feed.close();
    database.close();
  }
});

test("file-backed stores preserve lifecycle state across a close and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-feed-sqlite-"));
  const filename = join(directory, "feed.sqlite");
  try {
    const first = new SqliteAgentFeedStore({ filename });
    const started = first.beginRun(begin({ run_id: "run_sqlite_restart" }));
    first.completeRun(complete(started.run_id, {
      idempotency_key: "complete-sqlite-restart",
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    }));
    first.close();

    const restarted = new SqliteAgentFeedStore({ filename });
    try {
      const restored = restarted.getRunForTenant("default", started.run_id);
      assert.equal(restored?.status, "completed");
      assert.equal(restored?.complete_idempotency_key, "complete-sqlite-restart");
      assert.equal(restarted.listRuns({ tenant_id: "default" }).length, 1);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hostile security flags remain auditable data and are not silently promoted or discarded", () => {
  const feed = store();
  try {
    const started = feed.beginRun(begin({ run_id: "run_sqlite_hostile" }));
    const hostileFinding = { ...finding("finding-hostile", "evidence-hostile"), security_flags: ["prompt_injection"] };
    const accepted = feed.submitBatch(batch(started.run_id, {
      batch_id: "batch-hostile",
      idempotency_key: "batch-hostile",
      findings: [hostileFinding],
      evidence: [evidence("evidence-hostile")],
    }));
    assert.deepEqual(accepted.findings[0]?.finding.security_flags, ["prompt_injection"]);
    assert.deepEqual(feed.getRun("default", started.run_id)?.findings[0]?.finding.security_flags, ["prompt_injection"]);
  } finally {
    feed.close();
  }
});

test("stream expectations record never-seen, overdue, and recovered states without deleting incidents", () => {
  const database = new DatabaseSync(":memory:");
  const feed = new SqliteAgentFeedStore({ database });
  try {
    feed.registerStreamExpectation({
      tenant_id: "tenant_a",
      stream_id: "liveness.sqlite",
      expected_cadence_seconds: 3_600,
      grace_seconds: 0,
      enabled: true,
      expected_scope: { source_ids: ["source-1"], subjects: [] },
      owner: "sqlite-test",
      notes: "liveness fixture",
    });
    assert.equal(feed.sweepOverdueStreams("tenant_a", new Date("2026-08-18T00:00:00.000Z")).find((item) => item.stream_id === "liveness.sqlite")?.liveness_status, "never_seen");
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_a' and stream_id = 'liveness.sqlite' and status = 'open'").get().count, 1);
    const incidentId = database.prepare("select id from stream_liveness_incidents where tenant_id = 'tenant_a' and stream_id = 'liveness.sqlite'").get().id;
    assert.throws(() => database.prepare("update stream_liveness_incidents set details_json = '{}' where id = ?").run(incidentId), /append-only/u);
    assert.throws(() => database.prepare("delete from stream_liveness_incidents where id = ?").run(incidentId), /cannot be deleted/u);

    const started = feed.beginRun(begin({ run_id: "run_sqlite_liveness_a", idempotency_key: "begin-liveness-a", tenant_id: "tenant_a", stream_id: "liveness.sqlite" }));
    feed.completeRun(complete(started.run_id, {
      tenant_id: "tenant_a",
      idempotency_key: "complete-liveness-a",
      completed_at: "2026-08-18T00:01:00.000Z",
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    }));
    assert.equal(feed.sweepOverdueStreams("tenant_a", new Date("2026-08-18T00:30:00.000Z")).find((item) => item.stream_id === "liveness.sqlite")?.liveness_status, "healthy");
    assert.equal(feed.sweepOverdueStreams("tenant_a", new Date("2026-08-18T02:00:00.000Z")).find((item) => item.stream_id === "liveness.sqlite")?.liveness_status, "overdue");
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_a' and stream_id = 'liveness.sqlite' and status = 'open'").get().count, 1);

    const recovered = feed.beginRun(begin({ run_id: "run_sqlite_liveness_b", idempotency_key: "begin-liveness-b", tenant_id: "tenant_a", stream_id: "liveness.sqlite", started_at: "2026-08-18T02:00:00.000Z" }));
    feed.completeRun(complete(recovered.run_id, {
      tenant_id: "tenant_a",
      idempotency_key: "complete-liveness-b",
      completed_at: "2026-08-18T02:01:00.000Z",
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    }));
    assert.equal(feed.sweepOverdueStreams("tenant_a", new Date("2026-08-18T02:30:00.000Z")).find((item) => item.stream_id === "liveness.sqlite")?.liveness_status, "healthy");
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_a' and stream_id = 'liveness.sqlite'").get().count, 2);
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_a' and stream_id = 'liveness.sqlite' and status = 'resolved'").get().count, 2);
  } finally {
    feed.close();
    database.close();
  }
});

test("stream expectations and incidents are tenant-scoped even when stream IDs collide", () => {
  const database = new DatabaseSync(":memory:");
  const feed = new SqliteAgentFeedStore({ database });
  try {
    const expectation = (tenantId) => ({
      tenant_id: tenantId,
      stream_id: "shared.liveness",
      expected_cadence_seconds: 3_600,
      grace_seconds: 0,
      enabled: true,
      expected_scope: { source_ids: [], subjects: [] },
      owner: `${tenantId}-owner`,
    });
    feed.registerStreamExpectation(expectation("tenant_a"));
    feed.registerStreamExpectation(expectation("tenant_b"));
    assert.equal(feed.getStreamExpectation("tenant_a", "shared.liveness")?.owner, "tenant_a-owner");
    assert.equal(feed.getStreamExpectation("tenant_b", "shared.liveness")?.owner, "tenant_b-owner");
    assert.equal(feed.listStreamExpectations("tenant_a").length, 1);
    assert.equal(feed.listStreamExpectations("tenant_b").length, 1);

    const runA = feed.beginRun(begin({ tenant_id: "tenant_a", run_id: "run_shared_liveness", idempotency_key: "begin-shared-liveness-a", stream_id: "shared.liveness" }));
    feed.completeRun(complete(runA.run_id, {
      tenant_id: "tenant_a",
      idempotency_key: "complete-shared-liveness-a",
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    }));
    const runB = feed.beginRun(begin({ tenant_id: "tenant_b", run_id: "run_shared_liveness", idempotency_key: "begin-shared-liveness-b", stream_id: "shared.liveness" }));
    feed.completeRun(complete(runB.run_id, {
      tenant_id: "tenant_b",
      idempotency_key: "complete-shared-liveness-b",
      stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    }));
    assert.equal(feed.getStreamExpectation("tenant_a", "shared.liveness")?.last_terminal_status, "completed");
    assert.equal(feed.getStreamExpectation("tenant_b", "shared.liveness")?.last_terminal_status, "completed");

    feed.sweepOverdueStreams("tenant_a", new Date("2026-08-18T02:00:00.000Z"));
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_a'").get().count, 1);
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_b'").get().count, 0);
    feed.sweepOverdueStreams("tenant_b", new Date("2026-08-18T02:00:00.000Z"));
    assert.equal(database.prepare("select count(*) as count from stream_liveness_incidents where tenant_id = 'tenant_b'").get().count, 1);
  } finally {
    feed.close();
    database.close();
  }
});

test("finding_evidence trigger rejects a direct cross-run link", () => {
  const database = new DatabaseSync(":memory:");
  const feed = new SqliteAgentFeedStore({ database });
  try {
    const first = feed.beginRun(begin({ run_id: "run_sqlite_link_a" }));
    feed.submitBatch(batch(first.run_id, {
      batch_id: "batch-link-a",
      idempotency_key: "batch-link-a",
    }));
    const second = feed.beginRun(begin({ run_id: "run_sqlite_link_b", idempotency_key: "begin-sqlite-link-b" }));
    feed.submitBatch(batch(second.run_id, {
      batch_id: "batch-link-b",
      idempotency_key: "batch-link-b",
      findings: [finding("finding-link-b", "evidence-link-b")],
      evidence: [evidence("evidence-link-b")],
    }));
    const firstFinding = database.prepare("select id from findings where finding_key = 'finding-sqlite-001'").get().id;
    const secondEvidence = database.prepare("select id from evidence where evidence_key = 'evidence-link-b'").get().id;
    assert.throws(
      () => database.prepare("insert into finding_evidence (finding_id, evidence_id) values (?, ?)").run(firstFinding, secondEvidence),
      /same run/u,
    );
  } finally {
    feed.close();
    database.close();
  }
});
