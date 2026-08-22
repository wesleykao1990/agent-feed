import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./errors.ts";
import { payloadHash } from "./hash.ts";
import type {
  AppendTargetAttemptResult,
  TargetAttempt,
  TargetAttemptInput,
  TargetAttemptListOptions,
  TargetAttemptOutcome,
  TargetAttemptRecoveryDetail,
  TargetAttemptProjection,
} from "./types.ts";
import {
  TARGET_ATTEMPT_OUTCOMES,
  TARGET_ATTEMPT_RECOVERY_DETAIL_COMPATIBLE_OUTCOMES,
  TARGET_ATTEMPT_RECOVERY_DETAILS,
} from "./types.ts";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DIGEST_LENGTH = 64;
const MAX_LOCATOR_REFERENCE_LENGTH = 1_024;
const MAX_INTEGER = 2_147_483_647;
const IDENTIFIER_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SENSITIVE_LOCATOR_PATTERN = /(bearer|basic)[\s:=]+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|access[_-]?key|credential|password|secret|signature|token)[\s:=/]+[^\s/]+/iu;

type NormalizedTargetAttemptInput = Omit<Required<TargetAttemptInput>, "locator_digest" | "locator_reference" | "recovery_detail"> & {
  locator_digest: string | null;
  locator_reference: string | null;
  recovery_detail: TargetAttemptRecoveryDetail | null;
};

interface DbTargetAttemptRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  job_deployment_id: string;
  run_id: string;
  work_unit_id: string;
  target_id: string;
  attempt_number: number | string;
  idempotency_key: string;
  payload_hash: string;
  input_digest: string;
  outcome: TargetAttemptOutcome;
  recovery_detail: TargetAttemptRecoveryDetail | null;
  locator_digest: string | null;
  locator_reference: string | null;
  accepted_finding_count: number | string;
  accepted_evidence_count: number | string;
  attempted_at: Date | string;
  recorded_at: Date | string;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new PersistenceError("invalid_input", message, details);
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") invalid(`${field} must be a plain object`, { field });
  if (nodeTypes.isProxy(value)) invalid(`${field} must not be a Proxy`, { field });
  if (Array.isArray(value)) invalid(`${field} must be a plain object`, { field });
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalid(`${field} must be a plain object`, { field });
  }
  if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be a plain object`, { field });
  for (const key of ownKeys) {
    if (typeof key !== "string") invalid(`${field} must not contain symbol properties`, { field });
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) invalid(`${field}.${key} must be enumerable`, { field: `${field}.${key}` });
    if (!("value" in descriptor)) invalid(`${field}.${key} must be a data property`, { field: `${field}.${key}` });
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], field: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${field} contains unsupported field ${key}`, { field: `${field}.${key}` });
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${field}.${key} is required`, { field: `${field}.${key}` });
}

function text(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${field} must be a bounded non-whitespace string`, { field });
  }
  return value;
}

function deploymentId(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID_PATTERN.test(value)) invalid("job_deployment_id must be a deployment UUID", { field: "job_deployment_id" });
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length !== MAX_DIGEST_LENGTH || !DIGEST_PATTERN.test(value)) invalid(`${field} must be a lowercase SHA-256 digest`, { field });
  return value;
}

function nullableDigest(value: unknown, field: string): string | null {
  if (value === null) return null;
  return digest(value, field);
}

function nullableLocator(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_LOCATOR_REFERENCE_LENGTH || value.trim() !== value || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${field} must be a bounded credential-free reference`, { field });
  }
  if (/^data:/iu.test(value) || /:\/\/[^/\s]+@/u.test(value) || /[?#]/u.test(value) || SENSITIVE_LOCATOR_PATTERN.test(value)) {
    invalid(`${field} must not contain credentials, query/fragment material, or secret-like values`, { field });
  }
  return value;
}

function nullableRecoveryDetail(value: unknown, field: string): TargetAttemptRecoveryDetail | null {
  if (value === null) return null;
  if (typeof value !== "string" || !(TARGET_ATTEMPT_RECOVERY_DETAILS as readonly string[]).includes(value)) {
    invalid(`${field} is not supported`, { field });
  }
  return value as TargetAttemptRecoveryDetail;
}

function assertRecoveryDetailCoherence(outcome: TargetAttemptOutcome, recoveryDetail: TargetAttemptRecoveryDetail | null): void {
  if (recoveryDetail === null) return;
  const compatible = TARGET_ATTEMPT_RECOVERY_DETAIL_COMPATIBLE_OUTCOMES[recoveryDetail] as readonly string[];
  if (!compatible.includes(outcome)) {
    invalid("recovery_detail is incompatible with outcome", { field: "recovery_detail", outcome, recovery_detail: recoveryDetail });
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_INTEGER) invalid(`${field} must be a positive integer`, { field });
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_INTEGER) invalid(`${field} must be a non-negative integer`, { field });
  return value;
}

function attemptedAt(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) invalid("attempted_at must be an ISO date-time with an explicit timezone", { field: "attempted_at" });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) invalid("attempted_at must be a valid ISO date-time", { field: "attempted_at" });
  return value;
}

function normalizeInput(input: TargetAttemptInput): NormalizedTargetAttemptInput {
  const value = plainRecord(input, "target_attempt");
  exactKeys(value,
    ["job_deployment_id", "run_id", "work_unit_id", "target_id", "attempt_number", "idempotency_key", "input_digest", "outcome", "accepted_finding_count", "accepted_evidence_count", "attempted_at"],
    ["tenant_id", "recovery_detail", "locator_digest", "locator_reference"],
    "target_attempt");
  const tenantId = Object.hasOwn(value, "tenant_id") ? text(value.tenant_id, "tenant_id") : "default";
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !(TARGET_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) invalid("outcome is not supported", { field: "outcome" });
  const recoveryDetail = Object.hasOwn(value, "recovery_detail") ? nullableRecoveryDetail(value.recovery_detail, "recovery_detail") : null;
  assertRecoveryDetailCoherence(outcome as TargetAttemptOutcome, recoveryDetail);
  const locatorDigest = Object.hasOwn(value, "locator_digest") ? nullableDigest(value.locator_digest, "locator_digest") : null;
  const locatorReference = Object.hasOwn(value, "locator_reference") ? nullableLocator(value.locator_reference, "locator_reference") : null;
  return {
    tenant_id: tenantId,
    job_deployment_id: deploymentId(value.job_deployment_id),
    run_id: text(value.run_id, "run_id"),
    work_unit_id: text(value.work_unit_id, "work_unit_id"),
    target_id: text(value.target_id, "target_id"),
    attempt_number: positiveInteger(value.attempt_number, "attempt_number"),
    idempotency_key: text(value.idempotency_key, "idempotency_key"),
    input_digest: digest(value.input_digest, "input_digest"),
    outcome: outcome as TargetAttemptOutcome,
    recovery_detail: recoveryDetail,
    locator_digest: locatorDigest,
    locator_reference: locatorReference,
    accepted_finding_count: count(value.accepted_finding_count, "accepted_finding_count"),
    accepted_evidence_count: count(value.accepted_evidence_count, "accepted_evidence_count"),
    attempted_at: attemptedAt(value.attempted_at),
  };
}

function integer(value: number | string, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return result;
}

function timestamp(value: Date | string, field: string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return result.toISOString();
}

function mapAttempt(row: DbTargetAttemptRow): TargetAttempt {
  return Object.freeze({
    id: row.id,
    tenant_id: row.tenant_id,
    job_deployment_id: row.job_deployment_id,
    run_id: row.run_id,
    work_unit_id: row.work_unit_id,
    target_id: row.target_id,
    attempt_number: integer(row.attempt_number, "attempt_number"),
    idempotency_key: row.idempotency_key,
    payload_hash: row.payload_hash,
    input_digest: row.input_digest,
    outcome: row.outcome,
    recovery_detail: row.recovery_detail,
    locator_digest: row.locator_digest,
    locator_reference: row.locator_reference,
    accepted_finding_count: integer(row.accepted_finding_count, "accepted_finding_count"),
    accepted_evidence_count: integer(row.accepted_evidence_count, "accepted_evidence_count"),
    attempted_at: timestamp(row.attempted_at, "attempted_at"),
    recorded_at: timestamp(row.recorded_at, "recorded_at"),
  });
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof PersistenceError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint: unknown }).constraint) : "";
  const message = error instanceof Error ? error.message : "target attempt persistence failed";
  if (code === "23505" && constraint.includes("idempotency")) throw new PersistenceError("idempotency_payload_conflict", "target attempt idempotency key is already used", { constraint });
  if (code === "23503") throw new PersistenceError("run_not_found", "target attempt run was not found in the requested tenant", { constraint });
  if (code === "23514" || code === "22P02" || code === "P0001") throw new PersistenceError("invalid_input", message, { constraint });
  throw new PersistenceError("storage_error", "target attempt database operation failed", { constraint });
}

const ATTEMPT_COLUMNS = `id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
  attempt_number, idempotency_key, payload_hash, input_digest, outcome, recovery_detail,
  locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count,
  attempted_at, recorded_at`;

function lockKey(input: NormalizedTargetAttemptInput): string {
  return [input.tenant_id, input.job_deployment_id, input.run_id, input.work_unit_id, input.target_id].join("\u001f");
}

function attemptPayloadHash(input: NormalizedTargetAttemptInput): string {
  return payloadHash(input as unknown as Record<string, unknown>);
}

function legacyAttemptPayloadHash(input: NormalizedTargetAttemptInput): string | null {
  if (input.recovery_detail !== null) return null;
  // Rows written before migration 0009 were hashed without the nullable
  // extension. Keep those exact retries valid while new rows hash the field.
  const { recovery_detail: _recoveryDetail, ...legacyCompatible } = input;
  return payloadHash(legacyCompatible as unknown as Record<string, unknown>);
}

function projection(
  tenantId: string,
  jobDeploymentId: string,
  runId: string,
  workUnitId: string,
  targetId: string,
  latest: TargetAttempt | null,
  lastResolved: TargetAttempt | null,
): TargetAttemptProjection {
  return Object.freeze({
    tenant_id: tenantId,
    job_deployment_id: jobDeploymentId,
    run_id: runId,
    work_unit_id: workUnitId,
    target_id: targetId,
    latest,
    last_resolved: lastResolved,
  });
}

export class PostgresTargetAttemptRepository {
  readonly pool: Pool;

  constructor(pool: Pool) { this.pool = pool; }

  async appendTargetAttempt(input: TargetAttemptInput): Promise<AppendTargetAttemptResult> {
    const normalized = normalizeInput(input);
    const hash = attemptPayloadHash(normalized);
    const legacyHash = legacyAttemptPayloadHash(normalized);
    const client = await this.pool.connect();
    let transactionFailed = false;
    let transactionError: unknown;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(normalized)]);
      const run = await client.query<{ id: string }>(
        "select id from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for key share",
        [normalized.tenant_id, normalized.run_id],
      );
      if (!run.rows[0]) throw new PersistenceError("run_not_found", "target attempt run was not found in the requested tenant", { run_id: normalized.run_id });

      const deployment = await client.query<{ id: string }>(
        `select id from agent_feed.job_deployment_binding_versions
          where tenant_id = $1 and id = $2 for key share`,
        [normalized.tenant_id, normalized.job_deployment_id],
      );
      if (!deployment.rows[0]) throw new PersistenceError("invalid_input", "job deployment was not found in the requested tenant", { job_deployment_id: normalized.job_deployment_id });

      await client.query(
        `insert into agent_feed.target_attempt_run_deployments (tenant_id, run_id, job_deployment_id)
         values ($1,$2,$3) on conflict (tenant_id, run_id) do nothing`,
        [normalized.tenant_id, normalized.run_id, normalized.job_deployment_id],
      );
      const binding = await client.query<{ job_deployment_id: string }>(
        `select job_deployment_id from agent_feed.target_attempt_run_deployments
          where tenant_id = $1 and run_id = $2 for update`,
        [normalized.tenant_id, normalized.run_id],
      );
      if (!binding.rows[0]) throw new PersistenceError("storage_error", "target attempt run binding disappeared");
      if (binding.rows[0].job_deployment_id !== normalized.job_deployment_id) {
        throw new PersistenceError("invalid_input", "run is already bound to a different job deployment", {
          run_id: normalized.run_id,
          job_deployment_id: normalized.job_deployment_id,
        });
      }

      const existing = await client.query<DbTargetAttemptRow>(
        `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
          where tenant_id = $1 and idempotency_key = $2 for share`,
        [normalized.tenant_id, normalized.idempotency_key],
      );
      if (existing.rows[0]) {
        const attempt = existing.rows[0];
        if (attempt.payload_hash !== hash && attempt.payload_hash !== legacyHash) {
          throw new PersistenceError("idempotency_payload_conflict", "target attempt idempotency key was reused with a different payload", { idempotency_key: normalized.idempotency_key });
        }
        const mapped = mapAttempt(attempt);
        const state = await this.projectionWithClient(client, normalized);
        await client.query("commit");
        return { attempt: mapped, projection: state, appended: false };
      }

      const latest = await client.query<{ attempt_number: number | string }>(
        `select attempt_number from agent_feed.target_attempts
          where tenant_id = $1 and job_deployment_id = $2 and run_id = $3 and work_unit_id = $4 and target_id = $5
          order by attempt_number desc limit 1 for update`,
        [normalized.tenant_id, normalized.job_deployment_id, normalized.run_id, normalized.work_unit_id, normalized.target_id],
      );
      const expected = latest.rows[0] ? integer(latest.rows[0].attempt_number, "attempt_number") + 1 : 1;
      if (normalized.attempt_number !== expected) {
        throw new PersistenceError("invalid_input", "attempt_number must be the next monotone attempt for the target", {
          expected_attempt_number: expected,
          attempt_number: normalized.attempt_number,
        });
      }

      const inserted = await client.query<DbTargetAttemptRow>(
        `insert into agent_feed.target_attempts (
           id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
           attempt_number, idempotency_key, payload_hash, input_digest, outcome,
           recovery_detail, locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count, attempted_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning ${ATTEMPT_COLUMNS}`,
        [randomUUID(), normalized.tenant_id, normalized.job_deployment_id, normalized.run_id, normalized.work_unit_id,
          normalized.target_id, normalized.attempt_number, normalized.idempotency_key, hash, normalized.input_digest,
          normalized.outcome, normalized.recovery_detail, normalized.locator_digest, normalized.locator_reference,
          normalized.accepted_finding_count, normalized.accepted_evidence_count, normalized.attempted_at],
      );
      const row = inserted.rows[0];
      if (!row) throw new PersistenceError("storage_error", "target attempt insert returned no row");
      const attempt = mapAttempt(row);
      const state = await this.projectionWithClient(client, normalized);
      await client.query("commit");
      return { attempt, projection: state, appended: true };
    } catch (error) {
      transactionFailed = true;
      transactionError = error;
      try { await client.query("rollback"); } catch { /* preserve the original failure */ }
      return mapDatabaseError(error);
    } finally {
      if (transactionFailed) client.release(transactionError as Error);
      else client.release();
    }
  }

  async append_attempt(input: TargetAttemptInput): Promise<AppendTargetAttemptResult> {
    return this.appendTargetAttempt(input);
  }

  async appendAttempt(input: TargetAttemptInput): Promise<AppendTargetAttemptResult> {
    return this.appendTargetAttempt(input);
  }

  async getTargetAttemptProjection(
    tenantId: string,
    jobDeploymentId: string,
    runId: string,
    workUnitId: string,
    targetId: string,
  ): Promise<TargetAttemptProjection | null> {
    const tenant = text(tenantId, "tenant_id");
    const deployment = deploymentId(jobDeploymentId);
    const run = text(runId, "run_id");
    const unit = text(workUnitId, "work_unit_id");
    const target = text(targetId, "target_id");
    try {
      const [latest, resolved] = await Promise.all([
        this.pool.query<DbTargetAttemptRow>(
          `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
            where tenant_id = $1 and job_deployment_id = $2 and run_id = $3 and work_unit_id = $4 and target_id = $5
            order by attempt_number desc limit 1`, [tenant, deployment, run, unit, target]),
        this.pool.query<DbTargetAttemptRow>(
          `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
            where tenant_id = $1 and job_deployment_id = $2 and run_id = $3 and work_unit_id = $4 and target_id = $5
              and outcome = 'resolved'
            order by attempt_number desc limit 1`, [tenant, deployment, run, unit, target]),
      ]);
      if (!latest.rows[0] && !resolved.rows[0]) return null;
      return projection(tenant, deployment, run, unit, target,
        latest.rows[0] ? mapAttempt(latest.rows[0]) : null,
        resolved.rows[0] ? mapAttempt(resolved.rows[0]) : null);
    } catch (error) { return mapDatabaseError(error); }
  }

  async get_target_attempt_projection(tenantId: string, jobDeploymentId: string, runId: string, workUnitId: string, targetId: string): Promise<TargetAttemptProjection | null> {
    return this.getTargetAttemptProjection(tenantId, jobDeploymentId, runId, workUnitId, targetId);
  }

  async getTargetAttemptState(tenantId: string, jobDeploymentId: string, runId: string, workUnitId: string, targetId: string): Promise<TargetAttemptProjection | null> {
    return this.getTargetAttemptProjection(tenantId, jobDeploymentId, runId, workUnitId, targetId);
  }

  async get_target_attempt_state(tenantId: string, jobDeploymentId: string, runId: string, workUnitId: string, targetId: string): Promise<TargetAttemptProjection | null> {
    return this.getTargetAttemptProjection(tenantId, jobDeploymentId, runId, workUnitId, targetId);
  }

  async getTargetAttempt(tenantId: string, idempotencyKey: string): Promise<TargetAttempt | null> {
    const tenant = text(tenantId, "tenant_id");
    const key = text(idempotencyKey, "idempotency_key");
    try {
      const result = await this.pool.query<DbTargetAttemptRow>(
        `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts where tenant_id = $1 and idempotency_key = $2`, [tenant, key]);
      return result.rows[0] ? mapAttempt(result.rows[0]) : null;
    } catch (error) { return mapDatabaseError(error); }
  }

  async listTargetAttempts(options: TargetAttemptListOptions): Promise<TargetAttempt[]> {
    const value = plainRecord(options, "target_attempt_list");
    exactKeys(value, ["job_deployment_id", "run_id"], ["tenant_id", "work_unit_id", "target_id", "limit", "offset"], "target_attempt_list");
    const tenant = Object.hasOwn(value, "tenant_id") ? text(value.tenant_id, "tenant_id") : "default";
    const deployment = deploymentId(value.job_deployment_id);
    const run = text(value.run_id, "run_id");
    const unit = Object.hasOwn(value, "work_unit_id") ? text(value.work_unit_id, "work_unit_id") : null;
    const target = Object.hasOwn(value, "target_id") ? text(value.target_id, "target_id") : null;
    const limitValue = Object.hasOwn(value, "limit") ? value.limit : 100;
    const offsetValue = Object.hasOwn(value, "offset") ? value.offset : 0;
    if (typeof limitValue !== "number" || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 500) invalid("limit must be between 1 and 500", { field: "limit" });
    if (typeof offsetValue !== "number" || !Number.isSafeInteger(offsetValue) || offsetValue < 0) invalid("offset must be non-negative", { field: "offset" });
    try {
      const result = await this.pool.query<DbTargetAttemptRow>(
        `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
          where tenant_id = $1 and job_deployment_id = $2 and run_id = $3
            and ($4::text is null or work_unit_id = $4)
            and ($5::text is null or target_id = $5)
          order by work_unit_id, target_id, attempt_number
          limit $6 offset $7`, [tenant, deployment, run, unit, target, limitValue, offsetValue]);
      return result.rows.map(mapAttempt);
    } catch (error) { return mapDatabaseError(error); }
  }

  async list_target_attempts(options: TargetAttemptListOptions): Promise<TargetAttempt[]> {
    return this.listTargetAttempts(options);
  }

  private async projectionWithClient(client: PoolClient, input: NormalizedTargetAttemptInput): Promise<TargetAttemptProjection> {
    const params = [input.tenant_id, input.job_deployment_id, input.run_id, input.work_unit_id, input.target_id];
    const [latest, resolved] = await Promise.all([
      client.query<DbTargetAttemptRow>(
        `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
          where tenant_id = $1 and job_deployment_id = $2 and run_id = $3 and work_unit_id = $4 and target_id = $5
          order by attempt_number desc limit 1`, params),
      client.query<DbTargetAttemptRow>(
        `select ${ATTEMPT_COLUMNS} from agent_feed.target_attempts
          where tenant_id = $1 and job_deployment_id = $2 and run_id = $3 and work_unit_id = $4 and target_id = $5
            and outcome = 'resolved'
          order by attempt_number desc limit 1`, params),
    ]);
    return projection(input.tenant_id, input.job_deployment_id, input.run_id, input.work_unit_id, input.target_id,
      latest.rows[0] ? mapAttempt(latest.rows[0]) : null,
      resolved.rows[0] ? mapAttempt(resolved.rows[0]) : null);
  }
}

/** Naming alias for callers that model the sidecar as a store. */
export class PostgresTargetAttemptStore extends PostgresTargetAttemptRepository {}
