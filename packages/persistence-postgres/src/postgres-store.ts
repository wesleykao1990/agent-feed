import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./errors.ts";
import { payloadHash } from "./hash.ts";
import { appendOutboxEventInTransaction } from "./delivery-store.ts";
import { PostgresOccurrenceRepository } from "./occurrence-store.ts";
import { PostgresAssessmentRepository } from "./assessment-store.ts";
import { PostgresJobRegistryRepository } from "./job-registry-store.ts";
import { PostgresUtilityFeedbackRepository } from "./utility-feedback-store.ts";
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
  ExpectedOccurrence,
  ExpectedOccurrenceInput,
  ExpectedOccurrenceListOptions,
  MigrationQuarantineRecord,
  OccurrenceLiveness,
  OccurrenceLivenessOptions,
  RunOccurrenceLink,
  RunOccurrenceLinkInput,
  ScheduleExpectationListOptions,
  ScheduleExpectationVersion,
  ScheduleExpectationVersionInput,
  MaterializeScheduleOccurrencesInput,
  TrustedRunTriggerContext,
  TrustedRunTriggerContextInput,
  AssessmentListOptions,
  RunAssessmentReceipt,
  SubmitAssessmentInput,
  TrustedAssessorRegistrationVersion,
  TrustedAssessorRegistrationVersionInput,
  TrustedAssessorVersionContext,
  ValidationPolicyVersion,
  ValidationPolicyVersionInput,
} from "./types.ts";

const MAX_FINDINGS_PER_BATCH = 100;
const MAX_EVIDENCE_PER_BATCH = 100;
const MAX_EXCERPT_CHARACTERS = 4_000;
const TERMINAL_STATUSES: readonly TerminalRunStatus[] = ["completed", "partial", "failed", "cancelled"];

interface DbRunRow extends QueryResultRow {
  id: string;
  wire_run_id: string;
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

/**
 * Evidence handling is a delivery gate, not just producer metadata.  Treat
 * missing or malformed handling flags as unsafe so persistence fails closed
 * even when an upstream producer forgot to quarantine the finding.
 */
function evidenceHandlingAllowsDelivery(evidence: EvidencePayload): boolean {
  const handling = evidence?.handling;
  return Boolean(handling)
    && handling.contains_personal_data === false
    && handling.contains_secrets === false
    && handling.redistribution_restricted === false;
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
    if (constraint === "runs_pkey" || constraint === "runs_tenant_wire_run_id_key") {
      return new PersistenceError("run_id_conflict", "run_id is already used by another run", { constraint });
    }
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
  if (input.run_id !== undefined && (input.run_id.length < 8 || input.run_id.length > 512)) {
    throw new PersistenceError("invalid_input", "run_id must be between 8 and 512 characters");
  }
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

function makeBeginReceipt(row: DbRunRow, value: unknown): RunRecord {
  const envelope = asJsonObject(value) as unknown as RunEnvelope;
  return {
    run_id: row.wire_run_id,
    tenant_id: row.tenant_id,
    trace_id: row.trace_id,
    stream_id: row.stream_id,
    producer_id: row.producer_id,
    begin_idempotency_key: row.begin_idempotency_key,
    begin_payload_hash: row.begin_payload_hash,
    complete_idempotency_key: null,
    complete_payload_hash: null,
    status: "running",
    started_at: requiredIso(row.started_at),
    completed_at: null,
    envelope,
    batches: [],
    findings: [],
    evidence: [],
    stats: {
      sources_attempted: 0,
      sources_succeeded: 0,
      findings_submitted: 0,
      evidence_submitted: 0,
      batches_submitted: 0,
    },
  };
}

export const MIGRATION_SQL_URL = new URL("../migrations/0001_agent_feed.sql", import.meta.url);
export const DELIVERY_MIGRATION_SQL_URL = new URL("../migrations/0002_durable_delivery.sql", import.meta.url);
export const WIRE_RUN_ID_MIGRATION_SQL_URL = new URL("../migrations/0003_wire_run_id.sql", import.meta.url);
export const OCCURRENCE_LEDGER_MIGRATION_SQL_URL = new URL("../migrations/0004_occurrence_ledger.sql", import.meta.url);
/** Short compatibility alias for callers that name the sidecar migration by capability. */
export const OCCURRENCE_MIGRATION_SQL_URL = OCCURRENCE_LEDGER_MIGRATION_SQL_URL;
export const JOB_PROOF_MIGRATION_SQL_URL = new URL("../migrations/0005_job_proof.sql", import.meta.url);
/** Short compatibility alias for the Milestone 8 sidecar migration. */
export const ASSESSMENT_MIGRATION_SQL_URL = JOB_PROOF_MIGRATION_SQL_URL;
export const JOB_REGISTRY_MIGRATION_SQL_URL = new URL("../migrations/0006_job_registry.sql", import.meta.url);
export const UTILITY_FEEDBACK_MIGRATION_SQL_URL = new URL("../migrations/0007_utility_feedback.sql", import.meta.url);

/** Apply the ordered foundation and M2/M3/M7/M8/M9/M12 sidecar migrations. */
export async function migrateAgentFeed(pool: PgPool, sql?: string): Promise<void> {
  const migrations = sql === undefined
    ? [
      await readFile(MIGRATION_SQL_URL, "utf8"),
      await readFile(DELIVERY_MIGRATION_SQL_URL, "utf8"),
      await readFile(WIRE_RUN_ID_MIGRATION_SQL_URL, "utf8"),
      await readFile(OCCURRENCE_LEDGER_MIGRATION_SQL_URL, "utf8"),
      await readFile(JOB_PROOF_MIGRATION_SQL_URL, "utf8"),
      await readFile(JOB_REGISTRY_MIGRATION_SQL_URL, "utf8"),
      await readFile(UTILITY_FEEDBACK_MIGRATION_SQL_URL, "utf8"),
    ]
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
  readonly occurrence: PostgresOccurrenceRepository;
  readonly assessment: PostgresAssessmentRepository;
  readonly jobRegistry: PostgresJobRegistryRepository;
  readonly utilityFeedback: PostgresUtilityFeedbackRepository;

  constructor(pool: PgPool) {
    this.pool = pool;
    this.occurrence = new PostgresOccurrenceRepository(pool);
    this.assessment = new PostgresAssessmentRepository(pool);
    this.jobRegistry = new PostgresJobRegistryRepository(pool);
    this.utilityFeedback = new PostgresUtilityFeedbackRepository(pool as Pool);
  }

  /** Adapter-owned readiness probe used by transport composition roots. */
  async checkReady(): Promise<void> {
    await this.pool.query("select 1");
  }

  async beginRun(input: BeginRunRequest): Promise<RunRecord> {
    validateBegin(input);
    const tenantId = input.tenant_id ?? "default";
    const hash = payloadHash({ ...input, tenant_id: tenantId } as unknown as Record<string, unknown>);
    const runId = randomUUID();
    const wireRunId = input.run_id ?? runId;
    const envelope = makeRunningEnvelope(input, wireRunId);
    return this.withTransaction(async (client) => {
      const inserted = await client.query<DbRunRow>(
        `insert into agent_feed.runs (
           id, wire_run_id, tenant_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
           status, envelope, started_at
         ) values ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, $9)
         on conflict (tenant_id, producer_id, stream_id, begin_idempotency_key) do nothing
         returning id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                   status, envelope, started_at, completed_at, actual_scope,
                   error_summary, complete_idempotency_key, complete_payload_hash`,
        [runId, wireRunId, tenantId, input.stream_id, input.producer.producer_id, input.idempotency_key, hash, json(envelope), timestamp(input.started_at, "started_at")],
      );
      let row = inserted.rows[0];
      const created = row !== undefined;
      if (!row) {
        const existing = await client.query<DbRunRow>(
          `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
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
      if (!created) {
        const startedEvents = await client.query<{ event_id: string; payload: unknown }>(
          `select event_id, payload
             from agent_feed.outbox_events
            where tenant_id = $1 and event_key = $2`,
          [row.tenant_id, `evt_${row.wire_run_id}_started`],
        );
        if (startedEvents.rows.length !== 1) {
          throw new PersistenceError("storage_error", "idempotent begin is missing its durable run.started event", { run_id: row.wire_run_id });
        }
        return makeBeginReceipt(row, startedEvents.rows[0]!.payload);
      }
      // The run and its started event share this transaction. Exact retries
      // return above after checking that the original event exists; they must
      // not rebuild a started payload from a terminal run envelope.
      const storedEnvelope = asJsonObject(row.envelope);
      await appendOutboxEventInTransaction(client, {
        protocolVersion: "0.1",
        eventId: `evt_${row.wire_run_id}_started`,
        eventType: "run.started",
        tenantId: row.tenant_id,
        streamId: row.stream_id,
        runId: row.wire_run_id,
        findingId: null,
        occurredAt: requiredIso(row.started_at),
        sequence: "0",
        traceId: row.trace_id,
        payload: storedEnvelope as unknown as DeliveryEvent["payload"],
        payloadHash: payloadHash(storedEnvelope),
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
        `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                status, envelope, started_at, completed_at, actual_scope,
                error_summary, complete_idempotency_key, complete_payload_hash
           from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for update`, [tenantId, input.run_id]);
      const run = locked[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${input.run_id} was not found`, { run_id: input.run_id });
      if (run.tenant_id !== tenantId) throw new PersistenceError("run_not_found", `run ${input.run_id} is outside the requested tenant`, { run_id: input.run_id });

      // At-least-once producers can retry an accepted batch after complete_run
      // committed. Recognize the exact receipt before enforcing terminal
      // immutability; payload drift under the same key must still fail closed.
      const byKey = await this.query<DbBatchRow>(client,
        `select id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                submitted_at, metadata, accepted_at
           from agent_feed.batches where run_id = $1 and idempotency_key = $2`, [run.id, input.idempotency_key]);
      const existingByKey = byKey[0];
      if (existingByKey) {
        if (existingByKey.payload_hash !== hash) {
          throw new PersistenceError("idempotency_payload_conflict", "submit_batch idempotency key was reused with a different payload", { run_id: input.run_id, batch_id: existingByKey.batch_id });
        }
        return this.loadRun(client, run.id);
      }
      if (run.status !== "running") throw new PersistenceError("terminal_run_immutable", `run ${input.run_id} is terminal`, { run_id: input.run_id });

      const byBatchId = await this.query<DbBatchRow>(client,
        `select id, run_id, batch_id, idempotency_key, sequence_number, payload_hash,
                submitted_at, metadata, accepted_at
           from agent_feed.batches where run_id = $1 and batch_id = $2`, [run.id, input.batch_id]);
      if (byBatchId[0]) throw new PersistenceError("batch_id_conflict", `batch ${input.batch_id} already exists`, { run_id: input.run_id, batch_id: input.batch_id });

      const sequenceRows = await this.query<{ max_sequence: number | string | null }>(client,
        `select max(sequence_number) as max_sequence from agent_feed.batches where run_id = $1`, [run.id]);
      const maxSequence = sequenceRows[0]?.max_sequence === null || sequenceRows[0]?.max_sequence === undefined
        ? 0
        : asInt(sequenceRows[0].max_sequence);
      if (input.sequence_number <= maxSequence) {
        throw new PersistenceError("batch_sequence_not_increasing", "batch sequence numbers must increase within a run", { run_id: input.run_id, sequence_number: input.sequence_number, max_sequence: maxSequence });
      }

      const existingEvidenceRows = await this.query<{ id: string; evidence_key: string; payload: EvidencePayload }>(client,
        `select id, evidence_key, payload from agent_feed.submitted_evidence where run_id = $1`, [run.id]);
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
        `select finding_key from agent_feed.findings where run_id = $1`, [run.id]);
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
        [randomUUID(), tenantId, run.id, input.batch_id, input.idempotency_key, input.sequence_number, hash, timestamp(input.submitted_at, "submitted_at"), json(input.metadata)]);
      const batch = batchRows[0];
      if (!batch) throw new PersistenceError("storage_error", "batch insert returned no row");

      for (const evidence of input.evidence) {
        const rows = await this.query<{ id: string }>(client,
          `insert into agent_feed.submitted_evidence (id, tenant_id, run_id, batch_id, evidence_key, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
          [randomUUID(), tenantId, run.id, batch.id, evidence.evidence_id, json(evidence)]);
        const row = rows[0];
        if (!row) throw new PersistenceError("storage_error", "evidence insert returned no row");
        evidenceIdByKey.set(evidence.evidence_id, row.id);
        evidencePayloadByKey.set(evidence.evidence_id, evidence);
      }

      for (const finding of input.findings) {
        const rows = await this.query<{ id: string }>(client,
          `insert into agent_feed.findings (id, tenant_id, run_id, batch_id, finding_key, finding_type, payload)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
          [randomUUID(), tenantId, run.id, batch.id, finding.finding_id, finding.finding_type, json(finding)]);
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
        const referencedEvidence = finding.evidence_refs.map((evidenceId) => {
          const referenced = evidencePayloadByKey.get(evidenceId);
          if (!referenced) throw new PersistenceError("unresolved_evidence_ref", `finding ${finding.finding_id} references missing evidence ${evidenceId}`);
          return referenced;
        });
        const findingPayload = {
          finding,
          submitted_evidence: referencedEvidence,
        } as unknown as DeliveryEvent["payload"];
        const findingRecord = finding as unknown as Record<string, unknown>;
        const routingTags = Array.isArray(findingRecord.routing_tags)
          ? findingRecord.routing_tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        await appendOutboxEventInTransaction(client, {
          protocolVersion: "0.1",
          eventId: `evt_${run.wire_run_id}_${finding.finding_id}`,
          eventType: "finding.submitted",
          tenantId: run.tenant_id,
          streamId: run.stream_id,
          runId: run.wire_run_id,
          findingId: finding.finding_id,
          databaseFindingId: row.id,
          occurredAt: input.submitted_at,
          sequence: String(input.sequence_number),
          traceId: run.trace_id,
          payload: findingPayload,
          payloadHash: payloadHash(findingPayload as unknown as Record<string, unknown>),
          findingType: finding.finding_type,
          routingTags,
          deliveryEligible: finding.security_flags.length === 0
            && referencedEvidence.every(evidenceHandlingAllowsDelivery),
        });
      }
      return this.loadRun(client, run.id);
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
        `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
                status, envelope, started_at, completed_at, actual_scope,
                error_summary, complete_idempotency_key, complete_payload_hash
           from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for update`, [tenantId, input.run_id]);
      const run = rows[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${input.run_id} was not found`, { run_id: input.run_id });
      if (run.tenant_id !== tenantId) throw new PersistenceError("run_not_found", `run ${input.run_id} is outside the requested tenant`, { run_id: input.run_id });
      if (run.status !== "running") {
        if (run.complete_idempotency_key === input.idempotency_key) {
          if (run.complete_payload_hash !== hash) throw new PersistenceError("idempotency_payload_conflict", "complete_run idempotency key was reused with a different payload", { run_id: input.run_id });
          return this.loadRun(client, run.id);
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
           (select count(*) from agent_feed.submitted_evidence where run_id = $1) as evidence`, [run.id]);
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
        [run.id, input.status, json(envelope), completedAt, json(input.actual_scope), errorSummary(input.errors), input.idempotency_key, hash],
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
        eventId: `evt_${run.wire_run_id}_terminal`,
        eventType: terminalEventType,
        tenantId: run.tenant_id,
        streamId: run.stream_id,
        runId: run.wire_run_id,
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
      return this.loadRun(client, run.id);
    });
  }

  async complete_run(input: CompleteRunRequest): Promise<RunRecord> {
    return this.completeRun(input);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const rows = await this.query<DbRunRow>(this.pool,
      `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
              status, envelope, started_at, completed_at, actual_scope,
              error_summary, complete_idempotency_key, complete_payload_hash
         from agent_feed.runs where wire_run_id = $1`, [runId]);
    const row = rows[0];
    return row ? this.loadRun(this.pool, row.id) : null;
  }

  /** Tenant-scoped wire-ID lookup for authenticated producer/API callers. */
  async getRunForTenant(tenantId: string, runId: string): Promise<RunRecord | null> {
    const rows = await this.query<DbRunRow>(this.pool,
      `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
              status, envelope, started_at, completed_at, actual_scope,
              error_summary, complete_idempotency_key, complete_payload_hash
         from agent_feed.runs where tenant_id = $1 and wire_run_id = $2`, [tenantId, runId]);
    const row = rows[0];
    return row ? this.loadRun(this.pool, row.id) : null;
  }

  async get_run(runId: string): Promise<RunRecord | null> {
    return this.getRun(runId);
  }

  async get_run_for_tenant(tenantId: string, runId: string): Promise<RunRecord | null> {
    return this.getRunForTenant(tenantId, runId);
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    return this.listRunsInternal(undefined, options);
  }

  /** Tenant-scoped run listing for authenticated producer/API callers. */
  async listRunsForTenant(tenantId: string, options: ListRunsOptions = {}): Promise<RunRecord[]> {
    return this.listRunsInternal(tenantId, options);
  }

  async list_runs_for_tenant(tenantId: string, options: ListRunsOptions = {}): Promise<RunRecord[]> {
    return this.listRunsForTenant(tenantId, options);
  }

  private async listRunsInternal(tenantId: string | undefined, options: ListRunsOptions): Promise<RunRecord[]> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (tenantId !== undefined) {
      values.push(tenantId);
      predicates.push(`tenant_id = $${values.length}`);
    }
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
      `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
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

  // M7 occurrence sidecar methods.  These wrappers keep the historical
  // PostgresAgentFeedPersistence composition root usable while exposing the
  // focused repository as a standalone export for scheduler-neutral callers.
  async createScheduleExpectationVersion(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.occurrence.createScheduleExpectationVersion(input);
  }

  async registerScheduleExpectationVersion(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.occurrence.registerScheduleExpectationVersion(input);
  }

  async create_schedule_expectation_version(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.occurrence.create_schedule_expectation_version(input);
  }

  async register_schedule_expectation_version(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.occurrence.register_schedule_expectation_version(input);
  }

  async getScheduleExpectationVersion(tenantId: string, scheduleKey: string, version: number): Promise<ScheduleExpectationVersion | null> {
    return this.occurrence.getScheduleExpectationVersion(tenantId, scheduleKey, version);
  }

  async getScheduleExpectationVersionById(tenantId: string, id: string): Promise<ScheduleExpectationVersion | null> {
    return this.occurrence.getScheduleExpectationVersionById(tenantId, id);
  }

  async get_schedule_expectation_version(tenantId: string, scheduleKey: string, version: number): Promise<ScheduleExpectationVersion | null> {
    return this.occurrence.get_schedule_expectation_version(tenantId, scheduleKey, version);
  }

  async get_schedule_expectation_version_by_id(tenantId: string, id: string): Promise<ScheduleExpectationVersion | null> {
    return this.occurrence.get_schedule_expectation_version_by_id(tenantId, id);
  }

  async listScheduleExpectationVersions(options: ScheduleExpectationListOptions): Promise<ScheduleExpectationVersion[]> {
    return this.occurrence.listScheduleExpectationVersions(options);
  }

  async list_schedule_expectation_versions(options: ScheduleExpectationListOptions): Promise<ScheduleExpectationVersion[]> {
    return this.occurrence.list_schedule_expectation_versions(options);
  }

  async createExpectedOccurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.occurrence.createExpectedOccurrence(input);
  }

  async insertExpectedOccurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.occurrence.insertExpectedOccurrence(input);
  }

  async create_expected_occurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.occurrence.create_expected_occurrence(input);
  }

  async insert_expected_occurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.occurrence.insert_expected_occurrence(input);
  }

  async materializeExpectedOccurrences(inputs: ExpectedOccurrenceInput[]): Promise<ExpectedOccurrence[]> {
    return this.occurrence.materializeExpectedOccurrences(inputs);
  }

  async materialize_expected_occurrences(inputs: ExpectedOccurrenceInput[]): Promise<ExpectedOccurrence[]> {
    return this.occurrence.materialize_expected_occurrences(inputs);
  }

  async materializeScheduleOccurrences(input: MaterializeScheduleOccurrencesInput): Promise<ExpectedOccurrence[]> {
    return this.occurrence.materializeScheduleOccurrences(input);
  }

  async materialize_schedule_occurrences(input: MaterializeScheduleOccurrencesInput): Promise<ExpectedOccurrence[]> {
    return this.occurrence.materialize_schedule_occurrences(input);
  }

  async recordTrustedRunTriggerContext(input: TrustedRunTriggerContextInput): Promise<TrustedRunTriggerContext> {
    return this.occurrence.recordTrustedRunTriggerContext(input);
  }

  async record_trusted_run_trigger_context(input: TrustedRunTriggerContextInput): Promise<TrustedRunTriggerContext> {
    return this.occurrence.record_trusted_run_trigger_context(input);
  }

  async getTrustedRunTriggerContext(tenantId: string, runId: string): Promise<TrustedRunTriggerContext | null> {
    return this.occurrence.getTrustedRunTriggerContext(tenantId, runId);
  }

  async get_trusted_run_trigger_context(tenantId: string, runId: string): Promise<TrustedRunTriggerContext | null> {
    return this.occurrence.get_trusted_run_trigger_context(tenantId, runId);
  }

  async getExpectedOccurrence(tenantId: string, occurrenceId: string): Promise<ExpectedOccurrence | null> {
    return this.occurrence.getExpectedOccurrence(tenantId, occurrenceId);
  }

  async get_expected_occurrence(tenantId: string, occurrenceId: string): Promise<ExpectedOccurrence | null> {
    return this.occurrence.get_expected_occurrence(tenantId, occurrenceId);
  }

  async listExpectedOccurrences(options: ExpectedOccurrenceListOptions): Promise<ExpectedOccurrence[]> {
    return this.occurrence.listExpectedOccurrences(options);
  }

  async list_expected_occurrences(options: ExpectedOccurrenceListOptions): Promise<ExpectedOccurrence[]> {
    return this.occurrence.list_expected_occurrences(options);
  }

  async linkRunToOccurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.occurrence.linkRunToOccurrence(input);
  }

  async link_run_to_occurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.occurrence.link_run_to_occurrence(input);
  }

  async matchRunToOccurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.occurrence.matchRunToOccurrence(input);
  }

  async match_run_to_occurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.occurrence.match_run_to_occurrence(input);
  }

  async getRunOccurrenceLink(tenantId: string, linkId: string): Promise<RunOccurrenceLink | null> {
    return this.occurrence.getRunOccurrenceLink(tenantId, linkId);
  }

  async getRunOccurrenceLinkForRun(tenantId: string, runId: string): Promise<RunOccurrenceLink | null> {
    return this.occurrence.getRunOccurrenceLinkForRun(tenantId, runId);
  }

  async get_run_occurrence_link(tenantId: string, linkId: string): Promise<RunOccurrenceLink | null> {
    return this.occurrence.get_run_occurrence_link(tenantId, linkId);
  }

  async get_run_occurrence_link_for_run(tenantId: string, runId: string): Promise<RunOccurrenceLink | null> {
    return this.occurrence.get_run_occurrence_link_for_run(tenantId, runId);
  }

  async listRunOccurrenceLinks(tenantId: string, limit = 500, offset = 0): Promise<RunOccurrenceLink[]> {
    return this.occurrence.listRunOccurrenceLinks(tenantId, limit, offset);
  }

  async list_run_occurrence_links(tenantId: string, limit = 500, offset = 0): Promise<RunOccurrenceLink[]> {
    return this.occurrence.list_run_occurrence_links(tenantId, limit, offset);
  }

  async getOccurrenceLiveness(tenantId: string, occurrenceId: string, now: string | Date = new Date()): Promise<OccurrenceLiveness | null> {
    return this.occurrence.getOccurrenceLiveness(tenantId, occurrenceId, now);
  }

  async get_occurrence_liveness(tenantId: string, occurrenceId: string, now: string | Date = new Date()): Promise<OccurrenceLiveness | null> {
    return this.occurrence.get_occurrence_liveness(tenantId, occurrenceId, now);
  }

  async listOccurrenceLiveness(options: OccurrenceLivenessOptions): Promise<OccurrenceLiveness[]> {
    return this.occurrence.listOccurrenceLiveness(options);
  }

  async list_occurrence_liveness(options: OccurrenceLivenessOptions): Promise<OccurrenceLiveness[]> {
    return this.occurrence.list_occurrence_liveness(options);
  }

  async listMigrationQuarantine(tenantId = "default"): Promise<MigrationQuarantineRecord[]> {
    return this.occurrence.listMigrationQuarantine(tenantId);
  }

  async list_migration_quarantine(tenantId = "default"): Promise<MigrationQuarantineRecord[]> {
    return this.occurrence.list_migration_quarantine(tenantId);
  }

  async createValidationPolicyVersion(input: ValidationPolicyVersionInput): Promise<ValidationPolicyVersion> {
    return this.assessment.createValidationPolicyVersion(input);
  }

  async create_validation_policy_version(input: ValidationPolicyVersionInput): Promise<ValidationPolicyVersion> {
    return this.assessment.create_validation_policy_version(input);
  }

  async registerTrustedAssessorVersion(input: TrustedAssessorRegistrationVersionInput): Promise<TrustedAssessorRegistrationVersion> {
    return this.assessment.registerTrustedAssessorVersion(input);
  }

  async register_trusted_assessor_version(input: TrustedAssessorRegistrationVersionInput): Promise<TrustedAssessorRegistrationVersion> {
    return this.assessment.register_trusted_assessor_version(input);
  }

  async submitAssessment(input: SubmitAssessmentInput, context: TrustedAssessorVersionContext): Promise<RunAssessmentReceipt> {
    return this.assessment.submitAssessment(input, context);
  }

  async submit_assessment(input: SubmitAssessmentInput, context: TrustedAssessorVersionContext): Promise<RunAssessmentReceipt> {
    return this.assessment.submit_assessment(input, context);
  }

  async getAssessment(tenantId: string, id: string): Promise<RunAssessmentReceipt | null> {
    return this.assessment.getAssessment(tenantId, id);
  }

  async get_assessment(tenantId: string, id: string): Promise<RunAssessmentReceipt | null> {
    return this.assessment.get_assessment(tenantId, id);
  }

  async listAssessments(options: AssessmentListOptions): Promise<RunAssessmentReceipt[]> {
    return this.assessment.listAssessments(options);
  }

  async list_assessments(options: AssessmentListOptions): Promise<RunAssessmentReceipt[]> {
    return this.assessment.list_assessments(options);
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
      `select id, wire_run_id, tenant_id, trace_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash,
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
      run_id: row.wire_run_id,
      status: row.status,
      completed_at: iso(row.completed_at),
      actual_scope: row.actual_scope,
      stats,
      error_summary: row.error_summary,
    } as RunEnvelope;
    return {
      run_id: row.wire_run_id,
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
        run_id: row.wire_run_id,
        batch_id: batch.batch_id,
        idempotency_key: batch.idempotency_key,
        sequence_number: asInt(batch.sequence_number),
        payload_hash: batch.payload_hash,
        submitted_at: requiredIso(batch.submitted_at),
        metadata: asJsonObject(batch.metadata),
        accepted_at: requiredIso(batch.accepted_at),
      })),
      findings: findings.map((finding) => ({ id: finding.id, run_id: row.wire_run_id, batch_id: finding.batch_id, finding: finding.payload, created_at: requiredIso(finding.created_at) })),
      evidence: evidence.map((item) => ({ id: item.id, run_id: row.wire_run_id, batch_id: item.batch_id, evidence: item.payload, created_at: requiredIso(item.created_at) })),
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
