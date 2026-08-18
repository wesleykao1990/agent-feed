import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqlitePersistenceError } from "./errors.mjs";
import { jsonText, parseJson, payloadHash } from "./json.mjs";

const SCHEMA_URL = new URL("../schema.sql", import.meta.url);
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const MAX_FINDINGS_PER_BATCH = 100;
const MAX_EVIDENCE_PER_BATCH = 100;
const MAX_EXCERPT_CHARACTERS = 4_000;

function error(code, message = code, details = {}) {
  return new SqlitePersistenceError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw error("invalid_input", `${field} must be an ISO date-time`, { field });
  }
  return value;
}

function addSeconds(value, seconds) {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) throw error("invalid_input", "timestamp is invalid");
  return new Date(milliseconds + (seconds * 1_000)).toISOString();
}

function requiredString(value, field, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum) throw error("invalid_input", `${field} is invalid`, { field });
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw error("invalid_input", `${field} must be a non-negative integer`, { field });
  return value;
}

function terminalStatus(value) {
  if (!TERMINAL_STATUSES.has(value)) throw error("invalid_input", "status must be terminal", { status: value });
  return value;
}

function errorSummary(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((item) => (isObject(item) && typeof item.message === "string" && item.message.length > 0
    ? item.message
    : JSON.stringify(item))).join("; ");
}

function clone(value) {
  return structuredClone(value);
}

function asArray(value, field) {
  if (!Array.isArray(value)) throw error("invalid_input", `${field} must be an array`, { field });
  return value;
}

function assertProtocol(value, operation) {
  if (!isObject(value) || value.protocol_version !== "0.1") {
    throw error("invalid_input", `${operation} protocol_version must be 0.1`);
  }
}

function validateBegin(input) {
  assertProtocol(input, "begin_run");
  requiredString(input.idempotency_key, "idempotency_key", 8);
  requiredString(input.stream_id, "stream_id");
  if (!isObject(input.producer)) throw error("invalid_input", "producer is required");
  requiredString(input.producer.producer_id, "producer.producer_id");
  if (!isObject(input.task) || !isObject(input.expected_scope) || !isObject(input.metadata)) {
    throw error("invalid_input", "task, expected_scope, and metadata are required");
  }
  timestamp(input.started_at, "started_at");
  if (input.run_id !== undefined) requiredString(input.run_id, "run_id", 8);
}

function validateSubmit(input) {
  assertProtocol(input, "submit_batch");
  requiredString(input.run_id, "run_id", 8);
  requiredString(input.batch_id, "batch_id", 3);
  requiredString(input.idempotency_key, "idempotency_key", 8);
  if (!Number.isSafeInteger(input.sequence_number) || input.sequence_number < 1) {
    throw error("invalid_input", "sequence_number must be a positive integer");
  }
  timestamp(input.submitted_at, "submitted_at");
  const findings = asArray(input.findings, "findings");
  const evidence = asArray(input.evidence, "evidence");
  if (findings.length === 0 && evidence.length === 0) throw error("invalid_input", "a batch must contain findings or evidence");
  if (findings.length > MAX_FINDINGS_PER_BATCH || evidence.length > MAX_EVIDENCE_PER_BATCH) {
    throw error("invalid_input", "batch limit exceeded");
  }
  if (!isObject(input.metadata)) throw error("invalid_input", "metadata must be an object");
  for (const item of evidence) {
    if (!isObject(item)) throw error("invalid_input", "evidence items must be objects");
    requiredString(item.evidence_id, "evidence_id", 3);
    if (item.excerpt !== null && item.excerpt !== undefined
      && [...String(item.excerpt)].length > MAX_EXCERPT_CHARACTERS) {
      throw error("invalid_input", "evidence excerpt is too large");
    }
  }
  for (const item of findings) {
    if (!isObject(item)) throw error("invalid_input", "finding items must be objects");
    requiredString(item.finding_id, "finding_id", 3);
    if (!Array.isArray(item.evidence_refs)) throw error("invalid_input", "finding evidence_refs must be an array");
  }
}

function validateComplete(input) {
  assertProtocol(input, "complete_run");
  requiredString(input.run_id, "run_id", 8);
  requiredString(input.idempotency_key, "idempotency_key", 8);
  terminalStatus(input.status);
  timestamp(input.completed_at, "completed_at");
  if (!isObject(input.actual_scope) || !isObject(input.metadata)) throw error("invalid_input", "actual_scope and metadata are required");
  if (!isObject(input.stats)) throw error("invalid_input", "stats are required");
  for (const field of ["sources_attempted", "sources_succeeded", "findings_submitted", "evidence_submitted", "batches_submitted"]) {
    nonNegativeInteger(input.stats[field], `stats.${field}`);
  }
  if (input.stats.sources_succeeded > input.stats.sources_attempted) {
    throw error("invalid_scope_stats", "sources_succeeded cannot exceed sources_attempted");
  }
  asArray(input.errors, "errors");
}

function validateStreamExpectation(input) {
  if (!isObject(input)) throw error("invalid_input", "stream expectation is required");
  requiredString(input.tenant_id, "tenant_id");
  requiredString(input.stream_id, "stream_id");
  if (!Number.isSafeInteger(input.expected_cadence_seconds) || input.expected_cadence_seconds < 3_600) {
    throw error("invalid_input", "expected cadence must be at least one hour");
  }
  if (!Number.isSafeInteger(input.grace_seconds) || input.grace_seconds < 0) {
    throw error("invalid_input", "grace_seconds must be a non-negative integer");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw error("invalid_input", "enabled must be boolean");
  if (!isObject(input.expected_scope)) throw error("invalid_input", "expected_scope must be an object");
  requiredString(input.owner, "owner");
  if (input.notes !== undefined && typeof input.notes !== "string") throw error("invalid_input", "notes must be a string");
}

function mapExpectation(row) {
  if (!row) return null;
  return {
    tenant_id: rowValue(row, "tenant_id"),
    stream_id: rowValue(row, "stream_id"),
    expected_cadence_seconds: Number(rowValue(row, "expected_cadence_seconds")),
    grace_seconds: Number(rowValue(row, "grace_seconds")),
    enabled: Boolean(Number(rowValue(row, "enabled"))),
    expected_scope: parseJson(rowValue(row, "expected_scope_json"), "expected scope"),
    owner: rowValue(row, "owner"),
    notes: rowValue(row, "notes"),
    last_terminal_run_at: row["last_terminal_run_at"] ?? null,
    last_terminal_status: row["last_terminal_status"] ?? null,
    next_due_at: row["next_due_at"] ?? null,
    created_at: rowValue(row, "created_at"),
    updated_at: rowValue(row, "updated_at"),
  };
}

function makeRunningEnvelope(input, wireRunId) {
  return {
    protocol_version: "0.1",
    run_id: wireRunId,
    stream_id: input.stream_id,
    producer: clone(input.producer),
    task: clone(input.task),
    started_at: input.started_at,
    completed_at: null,
    status: "running",
    expected_scope: clone(input.expected_scope),
    actual_scope: null,
    stats: {
      sources_attempted: 0,
      sources_succeeded: 0,
      findings_submitted: 0,
      evidence_submitted: 0,
      batches_submitted: 0,
    },
    parent_run_id: input.parent_run_id ?? null,
    error_summary: null,
    metadata: clone(input.metadata),
  };
}

function rowValue(row, key) {
  const value = row?.[key];
  if (value === undefined) throw new Error(`SQLite row is missing ${key}`);
  return value;
}

/**
 * Small synchronous adapter used by the local portability example. The
 * public methods intentionally mirror the producer persistence port, while
 * the implementation stays dependency-free and never reaches PostgreSQL or
 * a delivery transport.
 */
export class SqliteAgentFeedStore {
  #db;
  #ownsDatabase;

  constructor({ filename = ":memory:", database, schema = readFileSync(fileURLToPath(SCHEMA_URL), "utf8") } = {}) {
    this.#db = database ?? new DatabaseSync(filename);
    this.#ownsDatabase = database === undefined;
    this.#db.exec("pragma foreign_keys = on");
    this.#db.exec(schema);
  }

  close() {
    if (this.#ownsDatabase) this.#db.close();
  }

  checkReady() {
    this.#db.prepare("select 1 as ready").get();
  }

  #transaction(operation) {
    this.#db.exec("begin immediate");
    try {
      const result = operation();
      this.#db.exec("commit");
      return result;
    } catch (cause) {
      try { this.#db.exec("rollback"); } catch { /* preserve the original failure */ }
      if (cause instanceof SqlitePersistenceError) throw cause;
      throw error("storage_error", "SQLite operation failed", { cause: String(cause?.message ?? cause) });
    }
  }

  #runByWire(tenantId, wireRunId) {
    return this.#db.prepare("select * from runs where tenant_id = ? and wire_run_id = ?").get(tenantId, wireRunId) ?? null;
  }

  #loadRun(internalId) {
    const row = this.#db.prepare("select * from runs where internal_id = ?").get(internalId);
    if (!row) throw error("run_not_found", "run was not found", { run_id: internalId });
    const envelope = parseJson(rowValue(row, "envelope_json"), "run envelope");
    const batches = this.#db.prepare("select * from batches where run_internal_id = ? order by sequence_number").all(internalId).map((item) => ({
      id: rowValue(item, "id"),
      run_id: rowValue(row, "wire_run_id"),
      batch_id: rowValue(item, "batch_id"),
      idempotency_key: rowValue(item, "idempotency_key"),
      sequence_number: Number(rowValue(item, "sequence_number")),
      payload_hash: rowValue(item, "payload_hash"),
      submitted_at: rowValue(item, "submitted_at"),
      metadata: parseJson(rowValue(item, "metadata_json"), "batch metadata"),
      accepted_at: rowValue(item, "accepted_at"),
    }));
    const findings = this.#db.prepare("select * from findings where run_internal_id = ? order by created_at, id").all(internalId).map((item) => ({
      id: rowValue(item, "id"),
      run_id: rowValue(row, "wire_run_id"),
      batch_id: this.#batchWireId(rowValue(item, "batch_id")),
      finding: parseJson(rowValue(item, "payload_json"), "finding payload"),
      created_at: rowValue(item, "created_at"),
    }));
    const evidence = this.#db.prepare("select * from evidence where run_internal_id = ? order by created_at, id").all(internalId).map((item) => ({
      id: rowValue(item, "id"),
      run_id: rowValue(row, "wire_run_id"),
      batch_id: this.#batchWireId(rowValue(item, "batch_id")),
      evidence: parseJson(rowValue(item, "payload_json"), "evidence payload"),
      created_at: rowValue(item, "created_at"),
    }));
    return {
      run_id: rowValue(row, "wire_run_id"),
      tenant_id: rowValue(row, "tenant_id"),
      trace_id: rowValue(row, "trace_id"),
      stream_id: rowValue(row, "stream_id"),
      producer_id: rowValue(row, "producer_id"),
      begin_idempotency_key: rowValue(row, "begin_idempotency_key"),
      begin_payload_hash: rowValue(row, "begin_payload_hash"),
      complete_idempotency_key: row["complete_idempotency_key"] ?? null,
      complete_payload_hash: row["complete_payload_hash"] ?? null,
      status: rowValue(row, "status"),
      started_at: rowValue(row, "started_at"),
      completed_at: row["completed_at"] ?? null,
      envelope: {
        ...envelope,
        run_id: rowValue(row, "wire_run_id"),
        status: rowValue(row, "status"),
        completed_at: row["completed_at"] ?? null,
        actual_scope: row["actual_scope_json"] === null ? null : parseJson(rowValue(row, "actual_scope_json"), "actual scope"),
        stats: {
          sources_attempted: Number(rowValue(row, "sources_attempted")),
          sources_succeeded: Number(rowValue(row, "sources_succeeded")),
          findings_submitted: findings.length,
          evidence_submitted: evidence.length,
          batches_submitted: batches.length,
        },
        error_summary: row["error_summary"] ?? null,
      },
      batches,
      findings,
      evidence,
      stats: {
        sources_attempted: Number(rowValue(row, "sources_attempted")),
        sources_succeeded: Number(rowValue(row, "sources_succeeded")),
        findings_submitted: findings.length,
        evidence_submitted: evidence.length,
        batches_submitted: batches.length,
      },
    };
  }

  #batchWireId(batchInternalId) {
    const row = this.#db.prepare("select batch_id from batches where id = ?").get(batchInternalId);
    return row ? rowValue(row, "batch_id") : batchInternalId;
  }

  beginRun(input) {
    validateBegin(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId });
    const wireRunId = input.run_id ?? randomUUID();
    return this.#transaction(() => {
      const existingByKey = this.#db.prepare(
        "select * from runs where tenant_id = ? and producer_id = ? and stream_id = ? and begin_idempotency_key = ?",
      ).get(tenantId, input.producer.producer_id, input.stream_id, input.idempotency_key);
      if (existingByKey) {
        if (rowValue(existingByKey, "begin_payload_hash") !== hash) {
          throw error("idempotency_payload_conflict", "begin_run idempotency key was reused with a different payload", { run_id: rowValue(existingByKey, "wire_run_id") });
        }
        return this.#loadRun(rowValue(existingByKey, "internal_id"));
      }
      const existingByWire = this.#runByWire(tenantId, wireRunId);
      if (existingByWire) throw error("run_id_conflict", "run_id is already used by another run", { run_id: wireRunId });
      const now = new Date().toISOString();
      const envelope = makeRunningEnvelope(input, wireRunId);
      const internalId = randomUUID();
      this.#db.prepare(`insert into runs (
        internal_id, tenant_id, wire_run_id, trace_id, stream_id, producer_id,
        begin_idempotency_key, begin_payload_hash, status, envelope_json,
        started_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(
        internalId, tenantId, wireRunId, randomUUID().replaceAll("-", ""), input.stream_id,
        input.producer.producer_id, input.idempotency_key, hash, jsonText(envelope), input.started_at, now,
      );
      return this.#loadRun(internalId);
    });
  }

  submitBatch(input) {
    validateSubmit(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId });
    return this.#transaction(() => {
      const run = this.#runByWire(tenantId, input.run_id);
      if (!run) throw error("run_not_found", "run was not found", { run_id: input.run_id });
      const internalId = rowValue(run, "internal_id");
      const existingByKey = this.#db.prepare("select * from batches where run_internal_id = ? and idempotency_key = ?").get(internalId, input.idempotency_key);
      if (existingByKey) {
        if (rowValue(existingByKey, "payload_hash") !== hash) throw error("idempotency_payload_conflict", "submit_batch idempotency key was reused with a different payload", { run_id: input.run_id, batch_id: rowValue(existingByKey, "batch_id") });
        return this.#loadRun(internalId);
      }
      if (rowValue(run, "status") !== "running") throw error("terminal_run_immutable", "terminal run is immutable", { run_id: input.run_id });
      const existingByBatchId = this.#db.prepare("select 1 as present from batches where run_internal_id = ? and batch_id = ?").get(internalId, input.batch_id);
      if (existingByBatchId) throw error("batch_id_conflict", "batch_id is already used by another batch", { run_id: input.run_id, batch_id: input.batch_id });
      const maxSequence = this.#db.prepare("select max(sequence_number) as max_sequence from batches where run_internal_id = ?").get(internalId)?.max_sequence;
      if (maxSequence !== null && maxSequence !== undefined && input.sequence_number <= Number(maxSequence)) {
        throw error("batch_sequence_not_increasing", "sequence_number must be strictly increasing", { run_id: input.run_id, sequence_number: input.sequence_number });
      }

      const findings = input.findings;
      const evidence = input.evidence;
      const findingIds = new Set();
      const evidenceIds = new Set();
      for (const item of findings) {
        if (findingIds.has(item.finding_id)) throw error("duplicate_finding", `duplicate finding ${item.finding_id}`, { finding_id: item.finding_id });
        findingIds.add(item.finding_id);
        if (this.#db.prepare("select 1 as present from findings where run_internal_id = ? and finding_key = ?").get(internalId, item.finding_id)) throw error("duplicate_finding", `duplicate finding ${item.finding_id}`, { finding_id: item.finding_id });
      }
      for (const item of evidence) {
        if (evidenceIds.has(item.evidence_id)) throw error("duplicate_evidence", `duplicate evidence ${item.evidence_id}`, { evidence_id: item.evidence_id });
        evidenceIds.add(item.evidence_id);
        if (this.#db.prepare("select 1 as present from evidence where run_internal_id = ? and evidence_key = ?").get(internalId, item.evidence_id)) throw error("duplicate_evidence", `duplicate evidence ${item.evidence_id}`, { evidence_id: item.evidence_id });
      }
      const existingEvidence = new Set(this.#db.prepare("select evidence_key from evidence where run_internal_id = ?").all(internalId).map((item) => rowValue(item, "evidence_key")));
      const acceptedEvidence = new Set([...existingEvidence, ...evidenceIds]);
      for (const finding of findings) {
        for (const evidenceId of finding.evidence_refs) {
          if (!acceptedEvidence.has(evidenceId)) throw error("unresolved_evidence_ref", `finding ${finding.finding_id} references missing evidence ${evidenceId}`, { finding_id: finding.finding_id, evidence_id: evidenceId });
        }
      }
      const now = new Date().toISOString();
      const batchInternalId = randomUUID();
      this.#db.prepare(`insert into batches (
        id, run_internal_id, batch_id, idempotency_key, sequence_number,
        payload_hash, submitted_at, metadata_json, accepted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        batchInternalId, internalId, input.batch_id, input.idempotency_key, input.sequence_number,
        hash, input.submitted_at, jsonText(input.metadata), now,
      );
      for (const item of evidence) {
        this.#db.prepare("insert into evidence (id, run_internal_id, batch_id, evidence_key, payload_json, created_at) values (?, ?, ?, ?, ?, ?)").run(
          randomUUID(), internalId, batchInternalId, item.evidence_id, jsonText(item), now,
        );
      }
      const evidenceRows = this.#db.prepare("select id, evidence_key from evidence where run_internal_id = ?").all(internalId);
      const evidenceIdsByKey = new Map(evidenceRows.map((item) => [rowValue(item, "evidence_key"), rowValue(item, "id")]));
      for (const item of findings) {
        const findingInternalId = randomUUID();
        this.#db.prepare("insert into findings (id, run_internal_id, batch_id, finding_key, payload_json, created_at) values (?, ?, ?, ?, ?, ?)").run(
          findingInternalId, internalId, batchInternalId, item.finding_id, jsonText(item), now,
        );
        for (const evidenceId of item.evidence_refs) {
          this.#db.prepare("insert into finding_evidence (finding_id, evidence_id) values (?, ?)").run(findingInternalId, evidenceIdsByKey.get(evidenceId));
        }
      }
      return this.#loadRun(internalId);
    });
  }

  completeRun(input) {
    validateComplete(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId });
    return this.#transaction(() => {
      const run = this.#runByWire(tenantId, input.run_id);
      if (!run) throw error("run_not_found", "run was not found", { run_id: input.run_id });
      const internalId = rowValue(run, "internal_id");
      if (rowValue(run, "status") !== "running") {
        if (rowValue(run, "complete_idempotency_key") === input.idempotency_key) {
          if (rowValue(run, "complete_payload_hash") !== hash) throw error("idempotency_payload_conflict", "complete_run idempotency key was reused with a different payload", { run_id: input.run_id });
          return this.#loadRun(internalId);
        }
        throw error("terminal_run_immutable", "terminal run is immutable", { run_id: input.run_id });
      }
      const startedAt = Date.parse(rowValue(run, "started_at"));
      const completedAt = Date.parse(input.completed_at);
      if (completedAt < startedAt) throw error("completion_before_start", "completed_at cannot precede started_at", { run_id: input.run_id });
      const accepted = {
        batches: Number(this.#db.prepare("select count(*) as count from batches where run_internal_id = ?").get(internalId).count),
        findings: Number(this.#db.prepare("select count(*) as count from findings where run_internal_id = ?").get(internalId).count),
        evidence: Number(this.#db.prepare("select count(*) as count from evidence where run_internal_id = ?").get(internalId).count),
      };
      if (input.stats.batches_submitted !== accepted.batches
        || input.stats.findings_submitted !== accepted.findings
        || input.stats.evidence_submitted !== accepted.evidence) {
        throw error("completion_counts_do_not_reconcile", "completion counts do not match accepted rows", { accepted, supplied: input.stats });
      }
      const oldEnvelope = parseJson(rowValue(run, "envelope_json"), "run envelope");
      const stats = {
        sources_attempted: input.stats.sources_attempted,
        sources_succeeded: input.stats.sources_succeeded,
        findings_submitted: accepted.findings,
        evidence_submitted: accepted.evidence,
        batches_submitted: accepted.batches,
      };
      const envelope = {
        ...oldEnvelope,
        completed_at: input.completed_at,
        status: input.status,
        actual_scope: clone(input.actual_scope),
        stats,
        error_summary: errorSummary(input.errors),
        metadata: clone(input.metadata),
      };
      this.#db.prepare(`update runs set
        status = ?, envelope_json = ?, completed_at = ?, actual_scope_json = ?,
        error_summary = ?, complete_idempotency_key = ?, complete_payload_hash = ?,
        sources_attempted = ?, sources_succeeded = ?
        where internal_id = ?`).run(
        input.status, jsonText(envelope), input.completed_at, jsonText(input.actual_scope),
        errorSummary(input.errors), input.idempotency_key, hash,
        input.stats.sources_attempted, input.stats.sources_succeeded, internalId,
      );
      const expectation = this.#db.prepare("select * from stream_expectations where tenant_id = ? and stream_id = ?").get(rowValue(run, "tenant_id"), rowValue(run, "stream_id"));
      if (expectation) {
        const nextDueAt = addSeconds(input.completed_at,
          Number(rowValue(expectation, "expected_cadence_seconds")) + Number(rowValue(expectation, "grace_seconds")));
        this.#db.prepare(`update stream_expectations set
          last_terminal_run_at = ?, last_terminal_status = ?, next_due_at = ?, updated_at = ?
          where tenant_id = ? and stream_id = ?`).run(
          input.completed_at, input.status, nextDueAt, new Date().toISOString(), rowValue(run, "tenant_id"), rowValue(run, "stream_id"),
        );
      }
      return this.#loadRun(internalId);
    });
  }

  registerStreamExpectation(input) {
    validateStreamExpectation(input);
    const enabled = input.enabled ?? true;
    const notes = input.notes ?? "";
    const now = new Date().toISOString();
    return this.#transaction(() => {
      const existing = this.#db.prepare("select * from stream_expectations where tenant_id = ? and stream_id = ?").get(input.tenant_id, input.stream_id);
      const nextDueAt = existing?.["last_terminal_run_at"]
        ? addSeconds(existing["last_terminal_run_at"], input.expected_cadence_seconds + input.grace_seconds)
        : null;
      if (existing) {
        this.#db.prepare(`update stream_expectations set
          expected_cadence_seconds = ?, grace_seconds = ?, enabled = ?, expected_scope_json = ?,
          owner = ?, notes = ?, next_due_at = ?, updated_at = ? where tenant_id = ? and stream_id = ?`).run(
          input.expected_cadence_seconds, input.grace_seconds, enabled ? 1 : 0,
          jsonText(input.expected_scope), input.owner, notes, nextDueAt, now, input.tenant_id, input.stream_id,
        );
      } else {
        this.#db.prepare(`insert into stream_expectations (
          tenant_id, stream_id, expected_cadence_seconds, grace_seconds, enabled,
          expected_scope_json, owner, notes, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.tenant_id, input.stream_id, input.expected_cadence_seconds, input.grace_seconds, enabled ? 1 : 0,
          jsonText(input.expected_scope), input.owner, notes, now, now,
        );
      }
      return mapExpectation(this.#db.prepare("select * from stream_expectations where tenant_id = ? and stream_id = ?").get(input.tenant_id, input.stream_id));
    });
  }

  register_stream_expectation(input) {
    return this.registerStreamExpectation(input);
  }

  getStreamExpectation(tenantId, streamId) {
    requiredString(tenantId, "tenant_id");
    requiredString(streamId, "stream_id");
    const row = this.#db.prepare("select * from stream_expectations where tenant_id = ? and stream_id = ?").get(tenantId, streamId);
    return mapExpectation(row);
  }

  get_stream_expectation(tenantId, streamId) {
    return this.getStreamExpectation(tenantId, streamId);
  }

  listStreamExpectations(tenantId) {
    requiredString(tenantId, "tenant_id");
    return this.#db.prepare("select * from stream_expectations where tenant_id = ? order by stream_id").all(tenantId).map(mapExpectation);
  }

  list_stream_expectations(tenantId) {
    return this.listStreamExpectations(tenantId);
  }

  sweepOverdueStreams(tenantId, now = new Date()) {
    requiredString(tenantId, "tenant_id");
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowDate.getTime())) throw error("invalid_input", "now must be a valid date");
    const nowIso = nowDate.toISOString();
    return this.#transaction(() => {
      const expectations = this.#db.prepare("select * from stream_expectations where tenant_id = ? order by stream_id").all(tenantId);
      for (const expectation of expectations) {
        const enabled = Boolean(Number(rowValue(expectation, "enabled")));
        const nextDueAt = expectation["next_due_at"] ?? null;
        const overdue = enabled && (nextDueAt === null || nowDate.getTime() > Date.parse(nextDueAt));
        if (overdue) {
          const openIncident = this.#db.prepare(`select id from stream_liveness_incidents
            where tenant_id = ? and stream_id = ? and incident_type = 'missed_run' and status in ('open', 'acknowledged')`).get(tenantId, rowValue(expectation, "stream_id"));
          if (!openIncident) {
            this.#db.prepare(`insert into stream_liveness_incidents (
              id, tenant_id, stream_id, incident_type, status, detected_at, expected_by, details_json
            ) values (?, ?, ?, 'missed_run', 'open', ?, ?, ?)`).run(
              randomUUID(), tenantId, rowValue(expectation, "stream_id"), nowIso, nextDueAt,
              jsonText({ last_terminal_run_at: expectation["last_terminal_run_at"] ?? null, last_terminal_status: expectation["last_terminal_status"] ?? null }),
            );
          }
        }
        if (nextDueAt !== null && nowDate.getTime() <= Date.parse(nextDueAt)) {
          this.#db.prepare(`update stream_liveness_incidents set status = 'resolved', resolved_at = ?
            where tenant_id = ? and stream_id = ? and incident_type = 'missed_run' and status in ('open', 'acknowledged')`).run(
            nowIso, tenantId, rowValue(expectation, "stream_id"),
          );
        }
      }
      return expectations.map((expectation) => {
        const enabled = Boolean(Number(rowValue(expectation, "enabled")));
        const lastTerminalAt = expectation["last_terminal_run_at"] ?? null;
        const lastTerminalStatus = expectation["last_terminal_status"] ?? null;
        const nextDueAt = expectation["next_due_at"] ?? null;
        const livenessStatus = !enabled
          ? "disabled"
          : lastTerminalAt === null
            ? "never_seen"
            : nextDueAt !== null && nowDate.getTime() > Date.parse(nextDueAt)
              ? "overdue"
              : lastTerminalStatus !== "completed"
                ? "degraded"
                : "healthy";
        return { tenant_id: tenantId, stream_id: rowValue(expectation, "stream_id"), liveness_status: livenessStatus, expected_by: nextDueAt };
      });
    });
  }

  sweep_overdue_streams(tenantId, now = new Date()) {
    return this.sweepOverdueStreams(tenantId, now);
  }

  getRunForTenant(tenantId, runId) {
    requiredString(tenantId, "tenant_id");
    requiredString(runId, "run_id");
    const row = this.#runByWire(tenantId, runId);
    return row ? this.#loadRun(rowValue(row, "internal_id")) : null;
  }

  getRun(tenantId, runId) {
    return this.getRunForTenant(tenantId, runId);
  }

  listRuns({ tenant_id: tenantId, stream_id: streamId, status, limit = 100, offset = 0 } = {}) {
    requiredString(tenantId, "tenant_id");
    const predicates = [];
    const values = [];
    predicates.push("tenant_id = ?");
    values.push(tenantId);
    if (streamId !== undefined) { predicates.push("stream_id = ?"); values.push(streamId); }
    if (status !== undefined) { predicates.push("status = ?"); values.push(status); }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    values.push(safeLimit, safeOffset);
    const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
    const rows = this.#db.prepare(`select internal_id from runs ${where} order by started_at desc, internal_id desc limit ? offset ?`).all(...values);
    return rows.map((row) => this.#loadRun(rowValue(row, "internal_id")));
  }
}

export { SCHEMA_URL };
