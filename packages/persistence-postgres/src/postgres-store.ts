import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./errors.ts";
import { payloadHash } from "./hash.ts";
import { appendOutboxEventInTransaction } from "./delivery-store.ts";
import type { DeliveryEvent } from "./delivery-types.ts";
import type {
  BeginRunRequest,
  CompleteRunRequest,
  EvidencePayload,
  FindingPayload,
  JsonObject,
  LivenessResult,
  ListRunsOptions,
  PgPool,
  PgTransactionClient,
  RunEnvelope,
  RunRecord,
  RunStats,
  RunStatus,
  Scope,
  StoredBatch,
  StoredEvidence,
  StoredFinding,
  StreamExpectation,
  StreamExpectationInput,
  SubmitBatchRequest,
  TerminalRunStatus,
} from "./types.ts";

const MAX_FINDINGS_PER_BATCH = 100;
const MAX_EVIDENCE_PER_BATCH = 100;
const MAX_EXCERPT_CHARACTERS = 4_000;
const TERMINAL_STATUSES: readonly TerminalRunStatus[] = ["completed", "partial", "failed", "cancelled"];

interface DbRunRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  trace_id: string;
  stream_id: string;
  producer_id: string;
  begin_idempotency_key: string;
  begin_payload_hash: string;
  status: RunStatus;
  envelope: JsonObject;
  started_at: Date | string;
  completed_at: Date | string | null;
  actual_scope: Scope | null;
  error_summary: string | null;
  complete_idempotency_key: string | null;
  complete_payload_hash: string | null;
}

interface DbBatchRow extends QueryResultRow {
  id: string;
  run_id: string;
  batch_id: string;
  idempotency_key: string;
  sequence_number: number | string;
  payload_hash: string;
  submitted_at: Date | string;
  metadata: JsonObject;
  accepted_at: Date | string;
}

interface DbFindingRow extends QueryResultRow {
  id: string;
  run_id: string;
  batch_id: string;
  payload: FindingPayload;
  created_at: Date | string;
}

interface DbEvidenceRow extends QueryResultRow {
  id: string;
  run_id: string;
  batch_id: string;
  payload: EvidencePayload;
  created_at: Date | string;
}

interface DbExpectationRow extends QueryResultRow {
  stream_id: string;
  expected_cadence_seconds: number | string;
  grace_seconds: number | string;
  enabled: boolean;
  expected_scope: StreamExpectationInput["expected_scope"];
  owner: string;
  notes: string;
  last_terminal_run_at: Date | string | null;
  last_terminal_status: TerminalRunStatus | null;
  next_due_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbLivenessRow extends QueryResultRow {
  stream_id: string;
  liveness_status: LivenessResult["liveness_status"];
  expected_by: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requiredIso(value: Date | string): string {
  const result = iso(value);
  if (result === null) throw new Error("database returned a null timestamp");
  return result;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error("database returned a non-object JSON payload");
}

function asInt(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`database returned an invalid integer: ${String(value)}`);
  return result;
}

function timestamp(input: string, field: string): Date {
  const result = new Date(input);
  if (Number.isNaN(result.getTime())) throw new PersistenceError("invalid_input", `${field} must be an ISO date-time`, { field });
  return result;
}

function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_STATUSES.includes(status as TerminalRunStatus);
}

function errorSummary(errors: CompleteRunRequest["errors"]): string | null {
  if (errors.length === 0) return null;
  const messages = errors.map((error) => {
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return JSON.stringify(error);
  });
  return messages.join("; ");
}

function mapDatabaseError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint: unknown }).constraint)
    : undefined;
  if (code === "23505") {
    if (constraint === "runs_pkey") return new PersistenceError("run_id_conflict", "run_id is already used by another run", { constraint });
    return new PersistenceError("storage_error", "database uniqueness constraint rejected the request", { constraint: constraint ?? "unique" });
  }
  if (code === "23514" || code === "23503" || code === "22P02") {
    return new PersistenceError("invalid_input", "database rejected the request", { constraint: code });
  }
  return new PersistenceError("storage_error", "database operation failed");
}

function validateBegin(input: BeginRunRequest): void {
  if (input.protocol_version !== "0.1") throw new PersistenceError("invalid_input", "protocol_version must be 0.1");
  if (input.idempotency_key.length < 8) throw new PersistenceError("invalid_input", "idempotency_key is too short");
  if (input.stream_id.length === 0 || input.producer.producer_id.length === 0) throw new PersistenceError("invalid_input", "stream and producer IDs are required");
  timestamp(input.started_at, "started_at");
}

function validateSubmit(input: SubmitBatchRequest): void {
  if (input.protocol_version !== "0.1") throw new PersistenceError("invalid_input", "protocol_version must be 0.1");
  if (input.idempotency_key.length < 8) throw new PersistenceError("invalid_input", "idempotency_key is too short");
  if (!Number.isSafeInteger(input.sequence_number) || input.sequence_number < 1) throw new PersistenceError("invalid_input", "sequence_number must be a positive integer");
  timestamp(input.submitted_at, "submitted_at");
  if (input.findings.length === 0 && input.evidence.length === 0) throw new PersistenceError("invalid_input", "a batch must contain findings or evidence");
  if (input.findings.length > MAX_FINDINGS_PER_BATCH || input.evidence.length > MAX_EVIDENCE_PER_BATCH) throw new PersistenceError("invalid_input", "batch limit exceeded");
  for (const evidence of input.evidence) {
    if (evidence.excerpt !== null && evidence.excerpt.length > MAX_EXCERPT_CHARACTERS) throw new PersistenceError("invalid_input", "evidence excerpt is too large");
  }
}

function validateComplete(input: CompleteRunRequest): void {
  if (input.protocol_version !== "0.1") throw new PersistenceError("invalid_input", "protocol_version must be 0.1");
  if (input.idempotency_key.length < 8) throw new PersistenceError("invalid_input", "idempotency_key is too short");
  if (!isTerminal(input.status)) throw new PersistenceError("invalid_input", "status must be terminal");
  timestamp(input.completed_at, "completed_at");
  if (!Number.isSafeInteger(input.stats.sources_attempted) || input.stats.sources_attempted < 0) throw new PersistenceError("invalid_input", "sources_attempted must be non-negative");
  if (!Number.isSafeInteger(input.stats.sources_succeeded) || input.stats.sources_succeeded < 0) throw new PersistenceError("invalid_input", "sources_succeeded must be non-negative");
  for (const field of ["findings_submitted", "evidence_submitted", "batches_submitted"] as const) {
    if (!Number.isSafeInteger(input.stats[field]) || input.stats[field] < 0) throw new PersistenceError("invalid_input", `${field} must be non-negative`);
  }
  if (input.stats.sources_succeeded > input.stats.sources_attempted) throw new PersistenceError("invalid_scope_stats", "sources_succeeded cannot exceed sources_attempted");
}

function makeRunningEnvelope(input: BeginRunRequest, runId: string): RunEnvelope {
  return {
    protocol_version: "0.1",
    run_id: runId,
    stream_id: input.stream_id,
    producer: input.producer,
    task: input.task,
    started_at: input.started_at,
    completed_at: null,
    status: "running",
    expected_scope: input.expected_scope,
    actual_scope: null,
    stats: {
      sources_attempted: 0,
      sources_succeeded: 0,
      findings_submitted: 0,
      evidence_submitted: 0,
      batches_submitted: 0,
    },
    parent_run_id: input.parent_run_id,
    error_summary: null,
    metadata: input.metadata,
  };
}

export const MIGRATION_SQL_URL = new URL("../migrations/0001_agent_feed.sql", import.meta.url);
export const DELIVERY_MIGRATION_SQL_URL = new URL("../migrations/0002_durable_delivery.sql", import.meta.url);

/** Apply M1 followed by the additive, idempotent M2 durable-delivery schema. */
export async function migrateAgentFeed(pool: PgPool, sql?: string): Promise<void> {
  const migrations = sql === undefined
    ? [await readFile(MIGRATION_SQL_URL, "utf8"), await readFile(DELIVERY_MIGRATION_SQL_URL, "utf8")]
    : [sql];
  // Two application processes may start against an empty database at the same
  // time.  PostgreSQL DDL/function replacement can deadlock without a single
  // migration session, so serialize this short startup critical section.
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('agent_feed:migrations', 0))");
    for (const migration of migrations) {
      // \set is a psql client directive and must not be sent through pg's protocol.
      await client.query(migration.replace(/^\\set ON_ERROR_STOP on\s*/u, ""));
    }
  } finally {
    try { await client.query("select pg_advisory_unlock(hashtextextended('agent_feed:migrations', 0))"); } catch { /* preserve migration failure */ }
    client.release();
  }
}

export function createAgentFeedPool(connectionString = process.env.AGENT_FEED_DATABASE_URL ?? process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("AGENT_FEED_DATABASE_URL or DATABASE_URL is required");
  return new Pool({ connectionString });
}

/**
 * PostgreSQL persistence boundary for the generic Agent Feed protocol.
 *
 * Each mutating operation owns its transaction. Batch acceptance locks its run
 * row before inspecting idempotency, sequence, and accepted IDs, so retries
 * and payload conflicts remain deterministic under concurrent producers.
 */
export class PostgresAgentFeedPersistence {
  readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async beginRun(input: BeginRunRequest): Promise<RunRecord> {
    validateBegin(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId } as unknown as Record<string, unknown>);
    const runId = input.run_id ?? randomUUID();
    const envelope = makeRunningEnvelope(input, runId);
    return this.withTransaction(async (client) => {
      const inserted = await client.query<DbRunRow>(
        `insert into agent_feed.runs (
           id, tenant_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
           status, envelope, started_at
         ) values ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8)
         on conflict (tenant_id, producer_id, stream_id, begin_idempotency_key) do nothing
         returning id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                   status, envelope, started_at, completed_at, actual_scope,
                   error_summary, complete_idempotency_key, complete_payload_hash`,
        [runId, tenantId, input.stream_id, input.producer.producer_id, input.idempotency_key, hash, json(envelope), timestamp(input.started_at, "started_at")],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<DbRunRow>(
          `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                  status, envelope, started_at, completed_at, actual_scope,
                  error_summary, complete_idempotency_key, complete_payload_hash
             from agent_feed.runs
            where producer_id = $1 and stream_id = $2 and begin_idempotency_key = $3
              and tenant_id = $4 for update`,
          [input.producer.producer_id, input.stream_id, input.idempotency_key, tenantId],
        );
        row = existing.rows[0];
      }
      if (!row) throw new PersistenceError("storage_error", "idempotent begin row disappeared");
      if (row.begin_payload_hash !== hash) {
        throw new PersistenceError("idempotency_payload_conflict", "begin_run idempotency key was reused with a different payload", { run_id: row.id });
      }
      await appendOutboxEventInTransaction(client, {
        protocolVersion: "0.1",
        eventId: `evt_${row.id}_started`,
        eventType: "run.started",
        tenantId: row.tenant_id,
        streamId: row.stream_id,
        runId: row.id,
        findingId: null,
        occurredAt: requiredIso(row.started_at),
        sequence: "0",
        traceId: row.trace_id,
        payload: envelope as unknown as DeliveryEvent["payload"],
        payloadHash: payloadHash(envelope as unknown as Record<string, unknown>),
        findingType: null,
        routingTags: [],
        deliveryEligible: true,
      });
      return this.loadRun(client, row.id);
    });
  }

  /** Protocol-name aliases for application layers that keep wire naming. */
  async begin_run(input: BeginRunRequest): Promise<RunRecord> {
    return this.beginRun(input);
  }

  async submitBatch(input: SubmitBatchRequest): Promise<RunRecord> {
    validateSubmit(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId } as unknown as Record<string, unknown>);
    return this.withTransaction(async (client) => {
      const locked = await this.query<DbRunRow>(client,
        `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                status, envelope, started_at, completed_at, actual_scope,
                error_summary, complete_idempotency_key, complete_payload_hash
           from agent_feed.runs where id = $1 for update`, [input.run_id]);
      const run = locked[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${input.run_id} was not found`, { run_id: input.run_id });
      if (run.tenant_id !== tenantId) throw new PersistenceError("run_not_found", `run ${input.run_id} is outside the requested tenant`, { run_id: input.run_id });
      if (run.status !== "running") throw new PersistenceError("terminal_run_immutable", `run ${input.run_id} is terminal`, { run_id: input.run_id });

      const byKey = await this.query<DbBatchRow>(client,
        `select id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                submitted_at, metadata, accepted_at
           from agent_feed.batches where run_id = $1 and idempotency_key = $2`, [input.run_id, input.idempotency_key]);
      const existingByKey = byKey[0];
      if (existingByKey) {
        if (existingByKey.payload_hash !== hash) {
          throw new PersistenceError("idempotency_payload_conflict", "submit_batch idempotency key was reused with a different payload", { run_id: input.run_id, batch_id: existingByKey.batch_id });
        }
        return this.loadRun(client, input.run_id);
      }

      const byBatchId = await this.query<DbBatchRow>(client,
        `select id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                submitted_at, metadata, accepted_at
           from agent_feed.batches where run_id = $1 and batch_id = $2`, [input.run_id, input.batch_id]);
      if (byBatchId[0]) throw new PersistenceError("batch_id_conflict", `batch ${input.batch_id} already exists`, { run_id: input.run_id, batch_id: input.batch_id });

      const sequenceRows = await this.query<{ max_sequence: number | string | null }>(client,
        `select max(sequence_number) as max_sequence from agent_feed.batches where run_id = $1`, [input.run_id]);
      const maxSequence = sequenceRows[0]?.max_sequence === null || sequenceRows[0]?.max_sequence === undefined
        ? 0
        : asInt(sequenceRows[0].max_sequence);
      if (input.sequence_number <= maxSequence) {
        throw new PersistenceError("batch_sequence_not_increasing", "batch sequence numbers must increase within a run", { run_id: input.run_id, sequence_number: input.sequence_number, max_sequence: maxSequence });
      }

      const existingEvidenceRows = await this.query<{ id: string; evidence_key: string; payload: EvidencePayload }>(client,
        `select id, evidence_key, payload from agent_feed.submitted_evidence where run_id = $1`, [input.run_id]);
      const evidenceIds = new Set<string>();
      const evidenceIdByKey = new Map<string, string>();
      const evidencePayloadByKey = new Map<string, EvidencePayload>();
      for (const row of existingEvidenceRows) {
        evidenceIds.add(row.evidence_key);
        evidenceIdByKey.set(row.evidence_key, row.id);
        evidencePayloadByKey.set(row.evidence_key, row.payload);
      }
      for (const evidence of input.evidence) {
        if (evidenceIds.has(evidence.evidence_id)) throw new PersistenceError("duplicate_evidence", `evidence ${evidence.evidence_id} already exists`, { evidence_id: evidence.evidence_id });
        evidenceIds.add(evidence.evidence_id);
        evidencePayloadByKey.set(evidence.evidence_id, evidence);
      }
      const findingIds = new Set<string>();
      const existingFindingRows = await this.query<{ finding_key: string }>(client,
        `select finding_key from agent_feed.findings where run_id = $1`, [input.run_id]);
      for (const row of existingFindingRows) findingIds.add(row.finding_key);
      for (const finding of input.findings) {
        if (findingIds.has(finding.finding_id)) throw new PersistenceError("duplicate_finding", `finding ${finding.finding_id} already exists`, { finding_id: finding.finding_id });
        findingIds.add(finding.finding_id);
        const refs = finding.evidence_refs;
        if (new Set(refs).size !== refs.length) throw new PersistenceError("invalid_input", `finding ${finding.finding_id} repeats an evidence reference`);
        for (const reference of refs) {
          if (!evidenceIds.has(reference)) throw new PersistenceError("unresolved_evidence_ref", `finding ${finding.finding_id} references missing evidence ${reference}`, { finding_id: finding.finding_id, evidence_id: reference });
        }
      }

      const batchRows = await this.query<DbBatchRow>(client,
        `insert into agent_feed.batches (
           id, tenant_id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
           submitted_at, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         returning id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                   submitted_at, metadata, accepted_at`,
        [randomUUID(), tenantId, input.run_id, input.batch_id, input.idempotency_key, input.sequence_number, hash, timestamp(input.submitted_at, "submitted_at"), json(input.metadata)]);
      const batch = batchRows[0];
      if (!batch) throw new PersistenceError("storage_error", "batch insert returned no row");

      for (const evidence of input.evidence) {
        const rows = await this.query<{ id: string }>(client,
          `insert into agent_feed.submitted_evidence (id, tenant_id, run_id, batch_id, evidence_key, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
          [randomUUID(), tenantId, input.run_id, batch.id, evidence.evidence_id, json(evidence)]);
        const row = rows[0];
        if (!row) throw new PersistenceError("storage_error", "evidence insert returned no row");
        evidenceIdByKey.set(evidence.evidence_id, row.id);
        evidencePayloadByKey.set(evidence.evidence_id, evidence);
      }

      for (const finding of input.findings) {
        const rows = await this.query<{ id: string }>(client,
          `insert into agent_feed.findings (id, tenant_id, run_id, batch_id, finding_key, finding_type, payload)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
          [randomUUID(), tenantId, input.run_id, batch.id, finding.finding_id, finding.finding_type, json(finding)]);
        const row = rows[0];
        if (!row) throw new PersistenceError("storage_error", "finding insert returned no row");
        for (const evidenceKey of finding.evidence_refs) {
          const evidenceId = evidenceIdByKey.get(evidenceKey);
          if (!evidenceId) throw new PersistenceError("unresolved_evidence_ref", `finding ${finding.finding_id} references missing evidence ${evidenceKey}`);
          await client.query(
            `insert into agent_feed.finding_evidence (tenant_id, finding_id, evidence_id) values ($1, $2, $3)`,
            [tenantId, row.id, evidenceId],
          );
        }
        const findingPayload = {
          finding,
          submitted_evidence: finding.evidence_refs.map((evidenceId) => {
            const referenced = evidencePayloadByKey.get(evidenceId);
            if (!referenced) throw new PersistenceError("unresolved_evidence_ref", `finding ${finding.finding_id} references missing evidence ${evidenceId}`);
            return referenced;
          }),
        } as unknown as DeliveryEvent["payload"];
        const findingRecord = finding as unknown as Record<string, unknown>;
        const routingTags = Array.isArray(findingRecord.routing_tags)
          ? findingRecord.routing_tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        await appendOutboxEventInTransaction(client, {
          protocolVersion: "0.1",
          eventId: `evt_${run.id}_${finding.finding_id}`,
          eventType: "finding.submitted",
          tenantId: run.tenant_id,
          streamId: run.stream_id,
          runId: run.id,
          findingId: finding.finding_id,
          databaseFindingId: row.id,
          occurredAt: input.submitted_at,
          sequence: String(input.sequence_number),
          traceId: run.trace_id,
          payload: findingPayload,
          payloadHash: payloadHash(findingPayload as unknown as Record<string, unknown>),
          findingType: finding.finding_type,
          routingTags,
          deliveryEligible: finding.security_flags.length === 0,
        });
      }
      return this.loadRun(client, input.run_id);
    });
  }

  async submit_batch(input: SubmitBatchRequest): Promise<RunRecord> {
    return this.submitBatch(input);
  }

  async completeRun(input: CompleteRunRequest): Promise<RunRecord> {
    validateComplete(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId } as unknown as Record<string, unknown>);
    return this.withTransaction(async (client) => {
      const rows = await this.query<DbRunRow>(client,
        `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                status, envelope, started_at, completed_at, actual_scope,
                error_summary, complete_idempotency_key, complete_payload_hash
           from agent_feed.runs where id = $1 for update`, [input.run_id]);
      const run = rows[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${input.run_id} was not found`, { run_id: input.run_id });
      if (run.tenant_id !== tenantId) throw new PersistenceError("run_not_found", `run ${input.run_id} is outside the requested tenant`, { run_id: input.run_id });
      if (run.status !== "running") {
        if (run.complete_idempotency_key === input.idempotency_key) {
          if (run.complete_payload_hash !== hash) throw new PersistenceError("idempotency_payload_conflict", "complete_run idempotency key was reused with a different payload", { run_id: input.run_id });
          return this.loadRun(client, input.run_id);
        }
        throw new PersistenceError("terminal_run_immutable", `run ${input.run_id} is already terminal`, { run_id: input.run_id });
      }

      const startedAt = new Date(requiredIso(run.started_at));
      const completedAt = timestamp(input.completed_at, "completed_at");
      if (completedAt.getTime() < startedAt.getTime()) throw new PersistenceError("completion_before_start", "completed_at cannot precede started_at", { run_id: input.run_id });
      const countRows = await this.query<{ batches: number | string; findings: number | string; evidence: number | string }>(client,
        `select
           (select count(*) from agent_feed.batches where run_id = $1) as batches,
           (select count(*) from agent_feed.findings where run_id = $1) as findings,
           (select count(*) from agent_feed.submitted_evidence where run_id = $1) as evidence`, [input.run_id]);
      const counts = countRows[0];
      if (!counts) throw new PersistenceError("storage_error", "count query returned no row");
      const accepted = { batches: asInt(counts.batches), findings: asInt(counts.findings), evidence: asInt(counts.evidence) };
      if (input.stats.batches_submitted !== accepted.batches
        || input.stats.findings_submitted !== accepted.findings
        || input.stats.evidence_submitted !== accepted.evidence) {
        throw new PersistenceError("completion_counts_do_not_reconcile", "completion counts do not match accepted rows", { accepted, supplied: input.stats });
      }

      const stats: RunStats = {
        sources_attempted: input.stats.sources_attempted,
        sources_succeeded: input.stats.sources_succeeded,
        findings_submitted: accepted.findings,
        evidence_submitted: accepted.evidence,
        batches_submitted: accepted.batches,
      };
      const envelope = {
        ...asJsonObject(run.envelope),
        completed_at: input.completed_at,
        status: input.status,
        actual_scope: input.actual_scope,
        stats,
        error_summary: errorSummary(input.errors),
        metadata: input.metadata,
      } as RunEnvelope;
      await client.query(
        `update agent_feed.runs
            set status = $2,
                envelope = $3::jsonb,
                completed_at = $4,
                actual_scope = $5::jsonb,
                error_summary = $6,
                complete_idempotency_key = $7,
                complete_payload_hash = $8
          where id = $1`,
        [input.run_id, input.status, json(envelope), completedAt, json(input.actual_scope), errorSummary(input.errors), input.idempotency_key, hash],
      );
      const terminalEventType = input.status === "completed"
        ? "run.completed"
        : input.status === "partial" ? "run.partial" : "run.failed";
      const terminalPayload = {
        status: input.status,
        completed_at: input.completed_at,
        actual_scope: input.actual_scope,
        expected_scope: asJsonObject(run.envelope).expected_scope,
        stats,
        error_summary: errorSummary(input.errors),
      } as unknown as DeliveryEvent["payload"];
      await appendOutboxEventInTransaction(client, {
        protocolVersion: "0.1",
        eventId: `evt_${run.id}_terminal`,
        eventType: terminalEventType,
        tenantId: run.tenant_id,
        streamId: run.stream_id,
        runId: run.id,
        findingId: null,
        occurredAt: input.completed_at,
        sequence: "0",
        traceId: run.trace_id,
        payload: terminalPayload,
        payloadHash: payloadHash(terminalPayload as unknown as Record<string, unknown>),
        findingType: null,
        routingTags: [],
        deliveryEligible: true,
      });
      return this.loadRun(client, input.run_id);
    });
  }

  async complete_run(input: CompleteRunRequest): Promise<RunRecord> {
    return this.completeRun(input);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const rows = await this.query<DbRunRow>(this.pool,
      `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
              status, envelope, started_at, completed_at, actual_scope,
              error_summary, complete_idempotency_key, complete_payload_hash
         from agent_feed.runs where id = $1`, [runId]);
    const row = rows[0];
    return row ? this.loadRun(this.pool, row.id) : null;
  }

  async get_run(runId: string): Promise<RunRecord | null> {
    return this.getRun(runId);
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (options.stream_id !== undefined) {
      values.push(options.stream_id);
      predicates.push(`stream_id = $${values.length}`);
    }
    if (options.status !== undefined) {
      values.push(options.status);
      predicates.push(`status = $${values.length}`);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    values.push(limit, offset);
    const where = predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
    const rows = await this.query<DbRunRow>(this.pool,
      `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
              status, envelope, started_at, completed_at, actual_scope,
              error_summary, complete_idempotency_key, complete_payload_hash
         from agent_feed.runs ${where}
        order by started_at desc, id desc limit $${values.length - 1} offset $${values.length}`,
      values);
    return Promise.all(rows.map((row) => this.loadRun(this.pool, row.id)));
  }

  async list_runs(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    return this.listRuns(options);
  }

  async registerStreamExpectation(input: StreamExpectationInput): Promise<StreamExpectation> {
    if (input.expected_cadence_seconds < 3_600 || !Number.isSafeInteger(input.expected_cadence_seconds)) throw new PersistenceError("invalid_input", "expected cadence must be at least one hour");
    if (input.grace_seconds < 0 || !Number.isSafeInteger(input.grace_seconds)) throw new PersistenceError("invalid_input", "grace_seconds must be non-negative");
    if (input.owner.length === 0) throw new PersistenceError("invalid_input", "expectation owner is required");
    const rows = await this.query<DbExpectationRow>(this.pool,
      `insert into agent_feed.stream_expectations (
         stream_id, expected_cadence_seconds, grace_seconds, enabled,
         expected_scope, owner, notes
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (stream_id) do update set
         expected_cadence_seconds = excluded.expected_cadence_seconds,
         grace_seconds = excluded.grace_seconds,
         enabled = excluded.enabled,
         expected_scope = excluded.expected_scope,
         owner = excluded.owner,
         notes = excluded.notes,
         next_due_at = case
           when agent_feed.stream_expectations.last_terminal_run_at is null then null
           else agent_feed.stream_expectations.last_terminal_run_at
             + make_interval(secs => excluded.expected_cadence_seconds + excluded.grace_seconds)
         end,
         updated_at = now()
       returning stream_id, expected_cadence_seconds, grace_seconds, enabled,
                 expected_scope, owner, notes, last_terminal_run_at,
                 last_terminal_status, next_due_at, created_at, updated_at`,
      [input.stream_id, input.expected_cadence_seconds, input.grace_seconds, input.enabled, json(input.expected_scope), input.owner, input.notes ?? ""],
    );
    const row = rows[0];
    if (!row) throw new PersistenceError("storage_error", "expectation upsert returned no row");
    return this.mapExpectation(row);
  }

  async register_stream_expectation(input: StreamExpectationInput): Promise<StreamExpectation> {
    return this.registerStreamExpectation(input);
  }

  async getStreamExpectation(streamId: string): Promise<StreamExpectation | null> {
    const rows = await this.query<DbExpectationRow>(this.pool,
      `select stream_id, expected_cadence_seconds, grace_seconds, enabled,
              expected_scope, owner, notes, last_terminal_run_at,
              last_terminal_status, next_due_at, created_at, updated_at
         from agent_feed.stream_expectations where stream_id = $1`, [streamId]);
    const row = rows[0];
    return row ? this.mapExpectation(row) : null;
  }

  async get_stream_expectation(streamId: string): Promise<StreamExpectation | null> {
    return this.getStreamExpectation(streamId);
  }

  async listStreamExpectations(): Promise<StreamExpectation[]> {
    const rows = await this.query<DbExpectationRow>(this.pool,
      `select stream_id, expected_cadence_seconds, grace_seconds, enabled,
              expected_scope, owner, notes, last_terminal_run_at,
              last_terminal_status, next_due_at, created_at, updated_at
         from agent_feed.stream_expectations order by stream_id`);
    return rows.map((row) => this.mapExpectation(row));
  }

  async list_stream_expectations(): Promise<StreamExpectation[]> {
    return this.listStreamExpectations();
  }

  async sweepOverdueStreams(now = new Date()): Promise<LivenessResult[]> {
    if (Number.isNaN(now.getTime())) throw new PersistenceError("invalid_input", "now must be a valid date");
    const rows = await this.query<DbLivenessRow>(this.pool,
      `select stream_id, liveness_status, expected_by
         from agent_feed.sweep_overdue_streams($1)`, [now]);
    return rows.map((row) => ({ stream_id: row.stream_id, liveness_status: row.liveness_status, expected_by: iso(row.expected_by) }));
  }

  async sweep_overdue_streams(now = new Date()): Promise<LivenessResult[]> {
    return this.sweepOverdueStreams(now);
  }

  private async withTransaction<T>(operation: (client: PgTransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve original failure */ }
      if (error instanceof PersistenceError) throw error;
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async query<T extends QueryResultRow>(client: PgPool | PoolClient, text: string, values: readonly unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, values as unknown[]);
    return result.rows;
  }

  private async loadRun(client: PgPool | PoolClient, runId: string): Promise<RunRecord> {
    const rows = await this.query<DbRunRow>(client,
      `select id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
              status, envelope, started_at, completed_at, actual_scope,
              error_summary, complete_idempotency_key, complete_payload_hash
         from agent_feed.runs where id = $1`, [runId]);
    const row = rows[0];
    if (!row) throw new PersistenceError("run_not_found", `run ${runId} was not found`, { run_id: runId });
    const [batches, findings, evidence] = await Promise.all([
      this.query<DbBatchRow>(client,
        `select id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                submitted_at, metadata, accepted_at
           from agent_feed.batches where run_id = $1 order by sequence_number`, [runId]),
      this.query<DbFindingRow>(client,
        `select id, run_id, batch_id, payload, created_at
           from agent_feed.findings where run_id = $1 order by created_at, id`, [runId]),
      this.query<DbEvidenceRow>(client,
        `select id, run_id, batch_id, payload, created_at
           from agent_feed.submitted_evidence where run_id = $1 order by created_at, id`, [runId]),
    ]);
    const statsFromEnvelope = asJsonObject(row.envelope).stats;
    const stats: RunStats = {
      sources_attempted: Number((statsFromEnvelope as Record<string, unknown> | undefined)?.sources_attempted ?? 0),
      sources_succeeded: Number((statsFromEnvelope as Record<string, unknown> | undefined)?.sources_succeeded ?? 0),
      findings_submitted: findings.length,
      evidence_submitted: evidence.length,
      batches_submitted: batches.length,
    };
    const envelope = {
      ...asJsonObject(row.envelope),
      run_id: row.id,
      status: row.status,
      completed_at: iso(row.completed_at),
      actual_scope: row.actual_scope,
      stats,
      error_summary: row.error_summary,
    } as RunEnvelope;
    return {
      run_id: row.id,
      tenant_id: row.tenant_id,
      trace_id: row.trace_id,
      stream_id: row.stream_id,
      producer_id: row.producer_id,
      begin_idempotency_key: row.begin_idempotency_key,
      begin_payload_hash: row.begin_payload_hash,
      complete_idempotency_key: row.complete_idempotency_key,
      complete_payload_hash: row.complete_payload_hash,
      status: row.status,
      started_at: requiredIso(row.started_at),
      completed_at: iso(row.completed_at),
      envelope,
      batches: batches.map((batch) => ({
        id: batch.id,
        run_id: batch.run_id,
        batch_id: batch.batch_id,
        idempotency_key: batch.idempotency_key,
        sequence_number: asInt(batch.sequence_number),
        payload_hash: batch.payload_hash,
        submitted_at: requiredIso(batch.submitted_at),
        metadata: asJsonObject(batch.metadata),
        accepted_at: requiredIso(batch.accepted_at),
      })),
      findings: findings.map((finding) => ({ id: finding.id, run_id: finding.run_id, batch_id: finding.batch_id, finding: finding.payload, created_at: requiredIso(finding.created_at) })),
      evidence: evidence.map((item) => ({ id: item.id, run_id: item.run_id, batch_id: item.batch_id, evidence: item.payload, created_at: requiredIso(item.created_at) })),
      stats,
    };
  }

  private mapExpectation(row: DbExpectationRow): StreamExpectation {
    return {
      stream_id: row.stream_id,
      expected_cadence_seconds: asInt(row.expected_cadence_seconds),
      grace_seconds: asInt(row.grace_seconds),
      enabled: row.enabled,
      expected_scope: row.expected_scope,
      owner: row.owner,
      notes: row.notes,
      last_terminal_run_at: iso(row.last_terminal_run_at),
      last_terminal_status: row.last_terminal_status,
      next_due_at: iso(row.next_due_at),
      created_at: requiredIso(row.created_at),
      updated_at: requiredIso(row.updated_at),
    };
  }
}

/** Naming alias for callers that model the boundary as a service. */
export class PostgresAgentFeedService extends PostgresAgentFeedPersistence {}

export type { PersistenceErrorCode } from "./errors.ts";
