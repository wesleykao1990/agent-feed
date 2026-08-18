import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { jsonHash, sha256Hex } from "./hash.ts";
import type {
  ArtifactAction,
  ArtifactClass,
  AuditEvent,
  AuditQuery,
  AuditSourceQuery,
  AuditSourceRecord,
  ExternalArtifactAdapter,
  ExternalArtifactResult,
  JsonObject,
  ManagedArtifact,
  ManagedArtifactInput,
  OperationsRepositoryOptions,
  OperationsSnapshot,
  PgQueryResultRow,
  RetentionExecutionRequest,
  RetentionExecutionResult,
  RetentionItemStatus,
  RetentionJob,
  RetentionPlanItem,
  RetentionPlanRequest,
  RetentionPolicy,
  RetentionPolicyInput,
  SqlClient,
  SqlExecutor,
  SqlPool,
} from "./types.ts";

export const OPERATIONS_MIGRATION_SQL_URL = new URL("../migrations/0004_operations.sql", import.meta.url);
export const DEFAULT_MAX_PLAN_ITEMS = 1000;
export const DEFAULT_MAX_AUDIT_ROWS = 1000;

/** Stable per-item identity supplied to the external idempotent adapter. */
export function retentionOperationId(tenantId: string, jobId: string, itemId: string): string {
  return sha256Hex(`${tenantId}:${jobId}:${itemId}`);
}

type JobRow = PgQueryResultRow & {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  policy_key: string;
  action: ArtifactAction;
  as_of: Date | string;
  requested_by: string;
  request_hash: string;
  max_items: number | string;
  status: RetentionJob["status"];
  candidate_count: number | string;
  completed_count: number | string;
  failed_count: number | string;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

type ItemRow = PgQueryResultRow & {
  id: string;
  artifact_id: string;
  artifact_key: string;
  storage_ref: string;
  artifact_class: ArtifactClass;
  action: ArtifactAction;
  expires_at: Date | string;
  status: RetentionItemStatus;
};

type ArtifactRow = PgQueryResultRow & {
  id: string;
  tenant_id: string;
  artifact_key: string;
  storage_ref: string;
  artifact_class: ArtifactClass;
  status: ManagedArtifact["status"];
  created_at: Date | string;
  expires_at: Date | string | null;
  content_hash: string | null;
  source_run_id: string | null;
  source_event_id: string | null;
  legal_hold: boolean;
  metadata: unknown;
  registered_at: Date | string;
  deleted_at: Date | string | null;
  tombstoned_at: Date | string | null;
};

function stringValue(value: unknown, field: string, min = 1, max = 2048): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new OperationsError("invalid_input", `${field} is invalid`);
  }
  return value;
}

/**
 * Storage references are opaque provider keys, not fetch URLs.  We accept
 * provider forms such as `s3://bucket/path` and `vault:recovery/key`, while
 * rejecting whitespace/control bytes, URL userinfo, queries, and fragments.
 * The external adapter owns provider-specific resolution.
 */
export function validateStorageReference(value: unknown): string {
  const reference = stringValue(value, "storageRef", 1, 2048);
  if (/[?#@\s\u0000-\u001f\u007f]/u.test(reference)) {
    throw new OperationsError("invalid_input", "storageRef must be an opaque credential-free reference");
  }
  if (reference.includes("://")) {
    try {
      const parsed = new URL(reference);
      if (!parsed.protocol || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
        throw new Error("invalid opaque URL");
      }
    } catch {
      throw new OperationsError("invalid_input", "storageRef has an invalid opaque URI form");
    }
  }
  return reference;
}

function optionalString(value: unknown, field: string, max = 2048): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, field, 1, max);
}

function iso(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new OperationsError("invalid_input", `${field} is not an ISO timestamp`);
  return parsed.toISOString();
}

function integer(value: number | string, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new OperationsError("storage_error", `database returned an invalid ${field}`);
  return result;
}

function object(value: unknown, field: string, maxBytes = 65536): JsonObject {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new OperationsError("invalid_input", `${field} must be an object`);
  const parsed = value as JsonObject;
  const encoded = JSON.stringify(parsed);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new OperationsError("invalid_input", `${field} is too large`);
  }
  assertSafeMetadata(parsed, field);
  return parsed;
}

export function validateMetadata(value: unknown, field = "metadata", maxBytes = 65536): JsonObject {
  return object(value, field, maxBytes);
}

const SENSITIVE_METADATA_KEY = /(?:secret|token|password|passwd|authorization|cookie|credential|private[_-]?key|api[_-]?key|access[_-]?key|refresh[_-]?token)/iu;

function assertSafeMetadata(value: unknown, path: string, depth = 0): void {
  if (depth > 8) throw new OperationsError("invalid_input", `${path} is too deeply nested`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeMetadata(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_METADATA_KEY.test(key)) throw new OperationsError("invalid_input", `${path}.${key} is not permitted`);
    assertSafeMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function dbDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new OperationsError("storage_error", "database returned an invalid timestamp");
  return date.toISOString();
}

function action(value: unknown): ArtifactAction {
  if (value === "delete" || value === "tombstone") return value;
  throw new OperationsError("storage_error", "database returned an invalid retention action");
}

function artifactClass(value: unknown): ArtifactClass {
  if (value === "recovery" || value === "submitted_artifact" || value === "export" || value === "other") return value;
  throw new OperationsError("storage_error", "database returned an invalid artifact class");
}

export function validateConfirmationToken(value: string): string {
  if (typeof value !== "string" || value.length < 43) {
    throw new OperationsError("confirmation_required", "confirmationToken must be a high-entropy base64url token");
  }
  const token = stringValue(value, "confirmationToken", 43, 256);
  if (!/^[A-Za-z0-9_-]{43,}$/u.test(token)) {
    throw new OperationsError("confirmation_required", "confirmationToken must be a high-entropy base64url token");
  }
  return token;
}

function requestHash(input: RetentionPlanRequest, maxItems: number): string {
  return jsonHash({
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    policyKey: input.policyKey,
    asOf: iso(input.asOf, "asOf"),
    requestedBy: input.requestedBy,
    maxItems,
  });
}

function policyFromRow(row: PgQueryResultRow): RetentionPolicy {
  return {
    id: stringValue(row.id, "policy.id"),
    tenantId: stringValue(row.tenant_id, "policy.tenant_id"),
    policyKey: stringValue(row.policy_key, "policy.policy_key"),
    artifactClass: artifactClass(row.artifact_class),
    action: action(row.action),
    retentionSeconds: integer(row.retention_seconds as number | string, "retention_seconds"),
    enabled: row.enabled === true,
    createdAt: dbDate(row.created_at as Date | string) ?? "",
    updatedAt: dbDate(row.updated_at as Date | string) ?? "",
  };
}

function artifactFromRow(row: ArtifactRow): ManagedArtifact {
  return {
    id: stringValue(row.id, "artifact.id"),
    tenantId: stringValue(row.tenant_id, "artifact.tenant_id"),
    artifactKey: stringValue(row.artifact_key, "artifact.artifact_key"),
    storageRef: stringValue(row.storage_ref, "artifact.storage_ref"),
    artifactClass: artifactClass(row.artifact_class),
    status: row.status,
    createdAt: dbDate(row.created_at) ?? "",
    expiresAt: dbDate(row.expires_at),
    contentHash: row.content_hash,
    sourceRunId: row.source_run_id,
    sourceEventId: row.source_event_id,
    legalHold: row.legal_hold === true,
    metadata: object(row.metadata, "artifact.metadata"),
    registeredAt: dbDate(row.registered_at) ?? "",
    deletedAt: dbDate(row.deleted_at),
    tombstonedAt: dbDate(row.tombstoned_at),
  };
}

function itemFromRow(row: ItemRow): RetentionPlanItem {
  return {
    id: stringValue(row.id, "item.id"),
    artifactId: stringValue(row.artifact_id, "item.artifact_id"),
    artifactKey: stringValue(row.artifact_key, "item.artifact_key"),
    storageRef: stringValue(row.storage_ref, "item.storage_ref"),
    artifactClass: artifactClass(row.artifact_class),
    action: action(row.action),
    expiresAt: dbDate(row.expires_at) ?? "",
    status: row.status,
  };
}

function jobFromRow(row: JobRow, items: RetentionPlanItem[]): RetentionJob {
  return {
    id: stringValue(row.id, "job.id"),
    tenantId: stringValue(row.tenant_id, "job.tenant_id"),
    idempotencyKey: stringValue(row.idempotency_key, "job.idempotency_key"),
    policyKey: stringValue(row.policy_key, "job.policy_key"),
    action: action(row.action),
    asOf: dbDate(row.as_of) ?? "",
    requestedBy: stringValue(row.requested_by, "job.requested_by"),
    requestHash: stringValue(row.request_hash, "job.request_hash", 64, 64),
    maxItems: integer(row.max_items, "max_items"),
    status: row.status,
    candidateCount: integer(row.candidate_count, "candidate_count"),
    completedCount: integer(row.completed_count, "completed_count"),
    failedCount: integer(row.failed_count, "failed_count"),
    createdAt: dbDate(row.created_at) ?? "",
    startedAt: dbDate(row.started_at),
    completedAt: dbDate(row.completed_at),
    items,
  };
}

function auditFromRow(row: PgQueryResultRow): AuditEvent {
  return {
    id: stringValue(row.id, "audit.id"),
    tenantId: stringValue(row.tenant_id, "audit.tenant_id"),
    jobId: row.job_id === null ? null : stringValue(row.job_id, "audit.job_id"),
    artifactId: row.artifact_id === null ? null : stringValue(row.artifact_id, "audit.artifact_id"),
    eventType: stringValue(row.event_type, "audit.event_type", 1, 64),
    actor: stringValue(row.actor, "audit.actor", 1, 256),
    details: object(row.details, "audit.details", 16384),
    occurredAt: dbDate(row.occurred_at as Date | string) ?? "",
  };
}

function auditSourceFromRow(row: PgQueryResultRow): AuditSourceRecord {
  return {
    sourceType: stringValue(row.source_type, "audit.source_type", 1, 64) as AuditSourceRecord["sourceType"],
    sourceId: stringValue(row.source_id, "audit.source_id", 1, 512),
    tenantId: stringValue(row.tenant_id, "audit.tenant_id", 1, 256),
    occurredAt: dbDate(row.occurred_at as Date | string) ?? "",
    metadata: object(row.metadata, "audit.metadata", 16384),
  };
}

export class OperationsError extends Error {
  readonly code: "invalid_input" | "not_found" | "idempotency_conflict" | "confirmation_required" | "scope_conflict" | "storage_error" | "external_failure";
  readonly details: Record<string, string>;

  constructor(
    code: OperationsError["code"],
    message: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "OperationsError";
    this.code = code;
    this.details = details;
  }
}

export function createOperationsPool(connectionString = process.env.AGENT_FEED_DATABASE_URL ?? process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new OperationsError("invalid_input", "AGENT_FEED_DATABASE_URL or DATABASE_URL is required");
  return new Pool({ connectionString });
}

/** Apply only the operations-owned additive migration. */
export async function migrateOperations(pool: SqlPool, sql?: string): Promise<void> {
  const migration = sql ?? await readFile(fileURLToPath(OPERATIONS_MIGRATION_SQL_URL), "utf8");
  const client = await pool.connect();
  try {
    await client.query(migration.replace(/^\\set ON_ERROR_STOP on\s*/u, ""));
  } finally {
    client.release();
  }
}

export class PostgresOperationsRepository {
  readonly pool: SqlPool;
  readonly maxPlanItems: number;
  readonly maxAuditRows: number;

  constructor(pool: SqlPool, options: OperationsRepositoryOptions = {}) {
    this.pool = pool;
    this.maxPlanItems = options.maxPlanItems ?? DEFAULT_MAX_PLAN_ITEMS;
    this.maxAuditRows = options.maxAuditRows ?? DEFAULT_MAX_AUDIT_ROWS;
    if (!Number.isSafeInteger(this.maxPlanItems) || this.maxPlanItems < 1 || this.maxPlanItems > DEFAULT_MAX_PLAN_ITEMS) {
      throw new OperationsError("invalid_input", "maxPlanItems must be between 1 and 1000");
    }
    if (!Number.isSafeInteger(this.maxAuditRows) || this.maxAuditRows < 1 || this.maxAuditRows > DEFAULT_MAX_AUDIT_ROWS) {
      throw new OperationsError("invalid_input", "maxAuditRows must be between 1 and 1000");
    }
  }

  async putPolicy(input: RetentionPolicyInput): Promise<RetentionPolicy> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const policyKey = stringValue(input.policyKey, "policyKey", 1, 256);
    const retentionSeconds = input.retentionSeconds;
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1) {
      throw new OperationsError("invalid_input", "retentionSeconds must be a positive integer");
    }
    const artifactClass = artifactClassValue(input.artifactClass);
    const requestedAction = action(input.action);
    const actor = tenantId;
    return this.withTransaction(async (client) => {
      const result = await client.query<PgQueryResultRow>(
        `insert into agent_feed.retention_policies (
           tenant_id, policy_key, artifact_class, action, retention_seconds, enabled
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, policy_key) do update
           set artifact_class = excluded.artifact_class,
               action = excluded.action,
               retention_seconds = excluded.retention_seconds,
               enabled = excluded.enabled,
               updated_at = now()
         returning id::text, tenant_id, policy_key, artifact_class, action,
                   retention_seconds, enabled, created_at, updated_at`,
        [tenantId, policyKey, artifactClass, requestedAction, retentionSeconds, input.enabled ?? true],
      );
      const row = result.rows[0];
      if (!row) throw new OperationsError("storage_error", "policy upsert returned no row");
      await this.audit(client, {
        tenantId,
        jobId: null,
        artifactId: null,
        eventType: "policy.upserted",
        actor,
        details: { policy_key: policyKey, action: requestedAction, class: artifactClass },
      });
      return policyFromRow(row);
    });
  }

  async registerArtifact(input: ManagedArtifactInput, actor = input.tenantId): Promise<ManagedArtifact> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const artifactKey = stringValue(input.artifactKey, "artifactKey", 1, 512);
    const storageRef = validateStorageReference(input.storageRef);
    const artifactClassValue = artifactClass(input.artifactClass);
    const createdAt = iso(input.createdAt, "createdAt");
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : iso(input.expiresAt, "expiresAt");
    const contentHash = input.contentHash === undefined || input.contentHash === null ? null : stringValue(input.contentHash, "contentHash", 71, 71);
    if (contentHash !== null && !/^sha256:[0-9a-f]{64}$/u.test(contentHash)) throw new OperationsError("invalid_input", "contentHash is invalid");
    const sourceRunId = optionalString(input.sourceRunId, "sourceRunId", 512);
    const sourceEventId = optionalString(input.sourceEventId, "sourceEventId", 512);
    const legalHold = input.legalHold ?? false;
    const metadata = object(input.metadata, "metadata");
    return this.withTransaction(async (client) => {
    const rows = await client.query<ArtifactRow>(
      `insert into agent_feed.managed_artifacts (
         tenant_id, artifact_key, storage_ref, artifact_class, created_at,
         expires_at, content_hash, source_run_id, source_event_id, legal_hold, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       on conflict (tenant_id, artifact_key) do nothing
       returning id::text, tenant_id, artifact_key, storage_ref, artifact_class,
                 status, created_at, expires_at, content_hash, source_run_id,
                 source_event_id, legal_hold, metadata, registered_at, deleted_at, tombstoned_at`,
      [tenantId, artifactKey, storageRef, artifactClassValue, createdAt, expiresAt, contentHash, sourceRunId, sourceEventId, legalHold, JSON.stringify(metadata)],
    );
    let row = rows.rows[0];
    const candidateHash = jsonHash({ tenantId, artifactKey, storageRef, artifactClass: artifactClassValue, createdAt, expiresAt, contentHash, sourceRunId, sourceEventId, legalHold, metadata });
    if (!row) {
      const existing = await client.query<ArtifactRow>(
        `select id::text, tenant_id, artifact_key, storage_ref, artifact_class,
                status, created_at, expires_at, content_hash, source_run_id,
                source_event_id, legal_hold, metadata, registered_at, deleted_at, tombstoned_at
           from agent_feed.managed_artifacts
          where tenant_id = $1 and artifact_key = $2`, [tenantId, artifactKey],
      );
      row = existing.rows[0];
      if (!row) throw new OperationsError("storage_error", "artifact registration disappeared");
      const existingHash = jsonHash({
        tenantId: row.tenant_id,
        artifactKey: row.artifact_key,
        storageRef: row.storage_ref,
        artifactClass: row.artifact_class,
        createdAt: dbDate(row.created_at),
        expiresAt: dbDate(row.expires_at),
        contentHash: row.content_hash,
        sourceRunId: row.source_run_id,
        sourceEventId: row.source_event_id,
        legalHold: row.legal_hold === true,
        metadata: object(row.metadata, "artifact.metadata"),
      });
      if (existingHash !== candidateHash) throw new OperationsError("idempotency_conflict", "artifact key was reused with different registration data");
      return artifactFromRow(row);
    }
    await this.audit(client, {
      tenantId,
      jobId: null,
      artifactId: row.id,
      eventType: "artifact.registered",
      actor: stringValue(actor, "actor", 1, 256),
      details: { class: artifactClassValue, registered: true },
    });
    return artifactFromRow(row);
    });
  }

  async planRetention(input: RetentionPlanRequest): Promise<RetentionJob> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const idempotencyKey = stringValue(input.idempotencyKey, "idempotencyKey", 8, 256);
    const policyKey = stringValue(input.policyKey, "policyKey", 1, 256);
    const asOf = iso(input.asOf, "asOf");
    const requestedBy = stringValue(input.requestedBy, "requestedBy", 1, 256);
    const maxItems = input.maxItems ?? this.maxPlanItems;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > this.maxPlanItems) {
      throw new OperationsError("invalid_input", `maxItems must be between 1 and ${this.maxPlanItems}`);
    }
    const hash = requestHash({ ...input, tenantId, idempotencyKey, policyKey, asOf, requestedBy, maxItems }, maxItems);
    return this.withTransaction(async (client) => {
      const policyRows = await client.query<PgQueryResultRow>(
        `select id::text, tenant_id, policy_key, artifact_class, action,
                retention_seconds, enabled, created_at, updated_at
           from agent_feed.retention_policies
          where tenant_id = $1 and policy_key = $2 and enabled`, [tenantId, policyKey],
      );
      const policyRow = policyRows.rows[0];
      if (!policyRow) throw new OperationsError("not_found", "retention policy was not found or is disabled");
      const policy = policyFromRow(policyRow);
      const inserted = await client.query<JobRow>(
        `insert into agent_feed.retention_jobs (
           tenant_id, idempotency_key, policy_key, action, as_of, requested_by,
           request_hash, max_items
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, idempotency_key) do nothing
         returning id::text, tenant_id, idempotency_key, policy_key, action,
                   as_of, requested_by, request_hash, max_items, status,
                   candidate_count, completed_count, failed_count, created_at,
                   started_at, completed_at`,
        [tenantId, idempotencyKey, policyKey, policy.action, asOf, requestedBy, hash, maxItems],
      );
      let jobRow = inserted.rows[0];
      if (!jobRow) {
        const existing = await client.query<JobRow>(
          `select id::text, tenant_id, idempotency_key, policy_key, action,
                  as_of, requested_by, request_hash, max_items, status,
                  candidate_count, completed_count, failed_count, created_at,
                  started_at, completed_at
             from agent_feed.retention_jobs
            where tenant_id = $1 and idempotency_key = $2 for update`, [tenantId, idempotencyKey],
        );
        jobRow = existing.rows[0];
        if (!jobRow) throw new OperationsError("storage_error", "retention job disappeared");
        if (jobRow.request_hash !== hash) throw new OperationsError("idempotency_conflict", "retention idempotency key was reused with different parameters");
        return this.loadJob(client, tenantId, jobRow.id, jobRow);
      }
      const candidates = await client.query<ItemRow>(
        `select a.id::text as artifact_id,
                a.artifact_key, a.storage_ref, a.artifact_class,
                p.action,
                coalesce(a.expires_at, a.created_at + make_interval(secs => p.retention_seconds)) as expires_at,
                a.status
           from agent_feed.managed_artifacts a
           join agent_feed.retention_policies p
             on p.tenant_id = a.tenant_id
            and p.policy_key = $2
            and p.artifact_class = a.artifact_class
            and p.enabled
          where a.tenant_id = $1
            and a.status in ('active', 'retained')
            and not a.legal_hold
            and coalesce(a.expires_at, a.created_at + make_interval(secs => p.retention_seconds)) <= $3
          order by coalesce(a.expires_at, a.created_at + make_interval(secs => p.retention_seconds)), a.id
          limit $4`, [tenantId, policyKey, asOf, maxItems],
      );
      for (const candidate of candidates.rows) {
        const artifactId = stringValue(candidate.artifact_id, "candidate.artifact_id");
        await client.query(
          `insert into agent_feed.retention_job_items (
             tenant_id, job_id, artifact_id, artifact_key, storage_ref,
             artifact_class, action, expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (tenant_id, job_id, artifact_id) do nothing`,
          [tenantId, jobRow.id, artifactId, candidate.artifact_key, candidate.storage_ref, artifactClass(candidate.artifact_class), action(candidate.action), candidate.expires_at],
        );
      }
      await client.query(
        `update agent_feed.retention_jobs
            set candidate_count = $3
          where tenant_id = $1 and id = $2`, [tenantId, jobRow.id, candidates.rows.length],
      );
      await this.audit(client, {
        tenantId,
        jobId: jobRow.id,
        artifactId: null,
        eventType: "retention.plan_created",
        actor: requestedBy,
        details: { policy_key: policyKey, candidate_count: candidates.rows.length, max_items: maxItems, as_of: asOf },
      });
      return this.loadJob(client, tenantId, jobRow.id);
    });
  }

  async executeRetention(
    input: RetentionExecutionRequest,
    adapter: ExternalArtifactAdapter,
  ): Promise<RetentionExecutionResult> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const jobId = stringValue(input.jobId, "jobId", 8, 128);
    const requestedBy = stringValue(input.requestedBy, "requestedBy", 1, 256);
    const confirmationToken = validateConfirmationToken(input.confirmationToken);
    const tokenHash = sha256Hex(confirmationToken);
    let job = await this.withTransaction(async (client) => {
      const rows = await client.query<JobRow>(
        `select id::text, tenant_id, idempotency_key, policy_key, action,
                as_of, requested_by, request_hash, max_items, status,
                candidate_count, completed_count, failed_count, created_at,
                started_at, completed_at
           from agent_feed.retention_jobs
          where tenant_id = $1 and id = $2 for update`, [tenantId, jobId],
      );
      const row = rows.rows[0];
      if (!row) throw new OperationsError("not_found", "retention job was not found");
      if (row.status === "completed") return this.loadJob(client, tenantId, jobId, row);
      const existingToken = await client.query<{ confirmation_token_hash: string | null }>(
        `select confirmation_token_hash from agent_feed.retention_jobs where tenant_id = $1 and id = $2 for update`, [tenantId, jobId],
      );
      const priorHash = existingToken.rows[0]?.confirmation_token_hash ?? null;
      if (priorHash !== null && priorHash !== tokenHash) throw new OperationsError("confirmation_required", "confirmation token does not match the retention job");
      await client.query(
        `update agent_feed.retention_jobs
            set status = 'executing',
                started_at = coalesce(started_at, now()),
                confirmation_token_hash = coalesce(confirmation_token_hash, $3)
          where tenant_id = $1 and id = $2`, [tenantId, jobId, tokenHash],
      );
      if (priorHash === null) {
        await this.audit(client, {
          tenantId,
          jobId,
          artifactId: null,
          eventType: "retention.confirmed",
          actor: requestedBy,
          details: { max_items: integer(row.max_items, "max_items") },
        });
      }
      return this.loadJob(client, tenantId, jobId);
    });

    if (job.status === "completed") return { job, attempted: 0, completed: job.completedCount, failed: job.failedCount };
    let attempted = 0;
    for (const item of job.items) {
      if (item.status === "deleted" || item.status === "tombstoned" || item.status === "skipped") continue;
      const claimed = await this.claimRetentionItem(tenantId, jobId, item, requestedBy);
      if (!claimed) continue;
      attempted += 1;
      let result: ExternalArtifactResult;
      try {
        result = await adapter.apply({
          tenantId,
          artifactId: item.artifactId,
          artifactKey: item.artifactKey,
          storageRef: item.storageRef,
          action: item.action,
          jobId,
          itemId: item.id,
          operationId: retentionOperationId(tenantId, jobId, item.id),
          confirmationToken,
        });
      } catch {
        result = { outcome: "failed", errorCode: "external_adapter_error" };
      }
      await this.recordExternalResult(tenantId, jobId, item, result, requestedBy);
      job = await this.loadJob(this.pool, tenantId, jobId);
    }
    job = await this.withTransaction(async (client) => {
      const current = await this.loadJob(client, tenantId, jobId);
      const inProgress = current.items.filter((item) => item.status === "in_progress").length;
      const failed = current.items.filter((item) => item.status === "failed").length;
      const completed = current.items.filter((item) => item.status === "deleted" || item.status === "tombstoned" || item.status === "skipped").length;
      if (inProgress > 0) {
        await client.query(
          `update agent_feed.retention_jobs
              set status = 'executing', completed_count = $3, failed_count = $4,
                  completed_at = null
            where tenant_id = $1 and id = $2`, [tenantId, jobId, completed, failed],
        );
        return this.loadJob(client, tenantId, jobId);
      }
      const status = failed === 0 ? "completed" : "failed";
      await client.query(
        `update agent_feed.retention_jobs
            set status = $3, completed_count = $4, failed_count = $5,
                completed_at = now()
          where tenant_id = $1 and id = $2`, [tenantId, jobId, status, completed, failed],
      );
      await this.audit(client, {
        tenantId,
        jobId,
        artifactId: null,
        eventType: status === "completed" ? "retention.completed" : "retention.failed",
        actor: requestedBy,
        details: { completed_count: completed, failed_count: failed },
      });
      return this.loadJob(client, tenantId, jobId);
    });
    return { job, attempted, completed: job.completedCount, failed: job.failedCount };
  }

  /**
   * Claim the artifact row and item in one short transaction.  The artifact
   * lock makes legal-hold changes race-safe: a hold set first causes a skip;
   * a hold set after this claim is rejected by the migration trigger while the
   * item is in_progress.  The transaction commits before external I/O.
   */
  private async claimRetentionItem(
    tenantId: string,
    jobId: string,
    item: RetentionPlanItem,
    actor: string,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const artifactRows = await client.query<{ status: ManagedArtifact["status"]; legal_hold: boolean }>(
        `select status, legal_hold
           from agent_feed.managed_artifacts
          where tenant_id = $1 and id = $2
          for update`, [tenantId, item.artifactId],
      );
      const artifact = artifactRows.rows[0];
      if (!artifact || artifact.legal_hold || (artifact.status !== "active" && artifact.status !== "retained")) {
        await client.query(
          `update agent_feed.retention_job_items
              set status = 'skipped', result_code = 'legal_hold_or_terminal',
                  claim_token = null, claim_expires_at = null, updated_at = now()
            where tenant_id = $1 and job_id = $2 and id = $3
              and status in ('planned', 'in_progress', 'failed')`, [tenantId, jobId, item.id],
        );
        await this.audit(client, {
          tenantId,
          jobId,
          artifactId: item.artifactId,
          eventType: "retention.item_skipped",
          actor,
          details: { result_code: artifact?.legal_hold ? "legal_hold" : "artifact_not_active" },
        });
        return false;
      }
      const itemRows = await client.query<{ status: RetentionItemStatus; claim_expires_at: Date | string | null }>(
        `select status, claim_expires_at
           from agent_feed.retention_job_items
          where tenant_id = $1 and job_id = $2 and id = $3
          for update`, [tenantId, jobId, item.id],
      );
      const existingItem = itemRows.rows[0];
      if (!existingItem) return false;
      if (existingItem.status === "in_progress"
        && existingItem.claim_expires_at !== null
        && new Date(existingItem.claim_expires_at).getTime() > Date.now()) {
        return false;
      }
      const updated = await client.query(
        `update agent_feed.retention_job_items
            set status = 'in_progress', claim_token = gen_random_uuid(),
                claim_expires_at = now() + interval '5 minutes', updated_at = now()
          where tenant_id = $1 and job_id = $2 and id = $3
            and status in ('planned', 'in_progress', 'failed')`, [tenantId, jobId, item.id],
      );
      return updated.rowCount !== 0;
    });
  }

  async listAudit(input: AuditQuery): Promise<AuditEvent[]> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const from = input.from === undefined ? null : iso(input.from, "from");
    const to = input.to === undefined ? null : iso(input.to, "to");
    const limit = input.limit ?? this.maxAuditRows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxAuditRows) throw new OperationsError("invalid_input", `limit must be between 1 and ${this.maxAuditRows}`);
    const rows = await this.pool.query<PgQueryResultRow>(
      `select id::text, tenant_id, job_id::text, artifact_id::text,
              event_type, actor, details, occurred_at
         from agent_feed.operations_audit
        where tenant_id = $1
          and ($2::timestamptz is null or occurred_at >= $2::timestamptz)
          and ($3::timestamptz is null or occurred_at < $3::timestamptz)
        order by occurred_at asc, id asc
        limit $4`, [tenantId, from, to, limit],
    );
    return rows.rows.map(auditFromRow);
  }

  /**
   * Return one deterministic, metadata-only audit stream across protocol,
   * durable-delivery, and operations records.  Liveness is intentionally
   * excluded because the current base schema has a global stream key rather
   * than a tenant-scoped relation; a trusted metrics adapter owns that view.
   * Payload JSON,
   * evidence excerpts, consumer receipts, URLs, and raw error details are
   * intentionally absent so this is safe as an operations-core export source.
   */
  async listAuditSources(input: AuditSourceQuery): Promise<AuditSourceRecord[]> {
    const tenantId = stringValue(input.tenantId, "tenantId", 1, 256);
    const from = input.from === undefined ? null : iso(input.from, "from");
    const to = input.to === undefined ? null : iso(input.to, "to");
    const limit = input.limit ?? this.maxAuditRows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxAuditRows) throw new OperationsError("invalid_input", `limit must be between 1 and ${this.maxAuditRows}`);
    const rows = await this.pool.query<PgQueryResultRow>(
      `with source_rows (source_type, source_id, tenant_id, occurred_at, metadata) as (
         select 'protocol.run', r.id::text, r.tenant_id, r.started_at,
                jsonb_build_object('wire_run_id', r.wire_run_id, 'stream_id', r.stream_id,
                  'producer_id', r.producer_id, 'status', r.status, 'trace_id', r.trace_id,
                  'completed_at', r.completed_at)
           from agent_feed.runs r
          where r.tenant_id = $1
         union all
         select 'protocol.batch', b.id::text, b.tenant_id, b.accepted_at,
                jsonb_build_object('run_id', b.run_id::text, 'batch_id', b.batch_id,
                  'sequence_number', b.sequence_number, 'payload_hash', b.payload_hash)
           from agent_feed.batches b
          where b.tenant_id = $1
         union all
         select 'protocol.finding', f.id::text, f.tenant_id, f.created_at,
                jsonb_build_object('run_id', f.run_id::text, 'batch_id', f.batch_id::text,
                  'finding_key', f.finding_key, 'finding_type', f.finding_type)
           from agent_feed.findings f
          where f.tenant_id = $1
         union all
         select 'protocol.evidence', e.id::text, e.tenant_id, e.created_at,
                jsonb_build_object('run_id', e.run_id::text, 'batch_id', e.batch_id::text,
                  'evidence_key', e.evidence_key)
           from agent_feed.submitted_evidence e
          where e.tenant_id = $1
         union all
         select 'delivery.outbox', o.event_id, o.tenant_id, o.occurred_at,
                jsonb_build_object('event_type', o.event_type, 'stream_id', o.stream_id,
                  'wire_run_id', o.wire_run_id, 'payload_hash', o.payload_hash,
                  'delivery_eligibility', o.delivery_eligibility, 'trace_id', o.trace_id)
           from agent_feed.outbox_events o
          where o.tenant_id = $1
         union all
         select 'delivery.delivery', d.id::text, d.tenant_id, d.created_at,
                jsonb_build_object('consumer_id', d.consumer_id, 'subscription_id', d.subscription_id::text,
                  'event_id', d.event_id, 'state', d.state, 'attempt_count', d.attempt_count,
                  'replay_count', d.replay_count)
           from agent_feed.consumer_deliveries d
          where d.tenant_id = $1
         union all
         select 'delivery.attempt', a.id::text, a.tenant_id, a.started_at,
                jsonb_build_object('consumer_id', a.consumer_id, 'delivery_id', a.delivery_id::text,
                  'attempt_number', a.attempt_number, 'attempt_kind', a.attempt_kind,
                  'state', a.state, 'http_status', a.http_status, 'error_code', a.error_code)
           from agent_feed.delivery_attempts a
          where a.tenant_id = $1
         union all
         select 'delivery.acknowledgement', a.id::text, a.tenant_id, a.acknowledged_at,
                jsonb_build_object('consumer_id', a.consumer_id, 'subscription_id', a.subscription_id::text,
                  'delivery_id', a.delivery_id::text, 'event_id', a.event_id,
                  'attempt_number', a.attempt_number)
           from agent_feed.acknowledgements a
          where a.tenant_id = $1
         union all
         select 'delivery.acknowledgement_command', a.id::text, a.tenant_id, a.created_at,
                jsonb_build_object('consumer_id', a.consumer_id, 'subscription_id', a.subscription_id::text,
                  'acknowledgement_id', a.acknowledgement_id::text)
           from agent_feed.acknowledgement_commands a
          where a.tenant_id = $1
         union all
         select 'delivery.replay', r.id::text, r.tenant_id, r.requested_at,
                jsonb_build_object('consumer_id', r.consumer_id, 'delivery_id', r.delivery_id::text,
                  'replay_generation', r.replay_generation, 'request_hash', r.request_hash)
           from agent_feed.delivery_replays r
          where r.tenant_id = $1
         union all
         select 'operations.audit', o.id::text, o.tenant_id, o.occurred_at,
                jsonb_build_object('job_id', o.job_id::text, 'artifact_id', o.artifact_id::text,
                  'event_type', o.event_type, 'actor', o.actor, 'details', o.details)
           from agent_feed.operations_audit o
          where o.tenant_id = $1
       )
       select source_type, source_id, tenant_id, occurred_at, metadata
         from source_rows
        where ($2::timestamptz is null or occurred_at >= $2::timestamptz)
          and ($3::timestamptz is null or occurred_at < $3::timestamptz)
        order by occurred_at asc, source_type asc, source_id asc
        limit $4`, [tenantId, from, to, limit],
    );
    return rows.rows.map(auditSourceFromRow);
  }

  /**
   * Return bounded counts only.  It intentionally does not return artifact
   * keys, source content, error strings, or per-consumer label dimensions.
   * Liveness is null until the base schema supplies a tenant-scoped stream
   * expectation relation; a global stream count would violate tenant scope.
   */
  async getSnapshot(tenantIdInput: string, asOfInput = new Date().toISOString()): Promise<OperationsSnapshot> {
    const tenantId = stringValue(tenantIdInput, "tenantId", 1, 256);
    const asOf = iso(asOfInput, "asOf");
    const artifacts = await this.pool.query<PgQueryResultRow>(
      `select
         count(*) filter (where a.status in ('active', 'retained'))::int as managed_artifacts,
         count(*) filter (
           where a.status in ('active', 'retained')
             and not a.legal_hold
             and exists (
               select 1 from agent_feed.retention_policies p
                where p.tenant_id = a.tenant_id
                  and p.artifact_class = a.artifact_class
                  and p.enabled
                  and coalesce(a.expires_at, a.created_at + make_interval(secs => p.retention_seconds)) <= $2
             )
         )::int as retention_candidates,
         count(*) filter (where a.status = 'deleted')::int as artifacts_deleted,
         count(*) filter (where a.status = 'tombstoned')::int as artifacts_tombstoned
       from agent_feed.managed_artifacts a
      where a.tenant_id = $1`, [tenantId, asOf],
    );
    const jobs = await this.pool.query<PgQueryResultRow>(
      `select
         count(*) filter (where status = 'planned')::int as planned_jobs,
         count(*) filter (where status = 'executing')::int as executing_jobs,
         count(*) filter (where status = 'failed')::int as failed_jobs
       from agent_feed.retention_jobs
      where tenant_id = $1`, [tenantId],
    );
    const deliveries = await this.pool.query<PgQueryResultRow>(
      `select
         count(*) filter (where state in ('pending', 'in_flight', 'retry_wait'))::int as pending_deliveries,
         case when min(created_at) filter (where state in ('pending', 'in_flight', 'retry_wait')) is null
           then null
           else greatest(0, floor(extract(epoch from ($2::timestamptz - min(created_at) filter (where state in ('pending', 'in_flight', 'retry_wait'))))))::int
         end as oldest_pending_age_seconds
       from agent_feed.consumer_deliveries
      where tenant_id = $1`, [tenantId, asOf],
    );
    const artifact = artifacts.rows[0] ?? {};
    const job = jobs.rows[0] ?? {};
    const delivery = deliveries.rows[0] ?? {};
    const intField = (row: PgQueryResultRow, key: string): number => integer(row[key] as number | string | undefined ?? 0, key);
    const nullableInt = delivery.oldest_pending_age_seconds === null || delivery.oldest_pending_age_seconds === undefined
      ? null : integer(delivery.oldest_pending_age_seconds as number | string, "oldest_pending_age_seconds");
    return {
      tenantId,
      asOf,
      managedArtifacts: intField(artifact, "managed_artifacts"),
      retentionCandidates: intField(artifact, "retention_candidates"),
      artifactsDeleted: intField(artifact, "artifacts_deleted"),
      artifactsTombstoned: intField(artifact, "artifacts_tombstoned"),
      plannedJobs: intField(job, "planned_jobs"),
      executingJobs: intField(job, "executing_jobs"),
      failedJobs: intField(job, "failed_jobs"),
      pendingDeliveries: intField(delivery, "pending_deliveries"),
      oldestPendingAgeSeconds: nullableInt,
      liveness: null,
    } as OperationsSnapshot;
  }

  private async recordExternalResult(
    tenantId: string,
    jobId: string,
    item: RetentionPlanItem,
    result: ExternalArtifactResult,
    actor: string,
  ): Promise<void> {
    const outcome = result.outcome;
    const boundedCode = result.errorCode === null || result.errorCode === undefined
      ? (outcome === "failed" ? "external_failure" : outcome)
      : String(result.errorCode).slice(0, 64).replace(/[^a-z0-9_.-]/giu, "_").toLowerCase();
    await this.withTransaction(async (client) => {
      if (outcome === "deleted" || outcome === "already_absent") {
        const artifactUpdate = await client.query(
          `update agent_feed.managed_artifacts
              set status = 'deleted', deleted_at = coalesce(deleted_at, now())
            where tenant_id = $1 and id = $2 and status in ('active', 'retained') and not legal_hold`, [tenantId, item.artifactId],
        );
        if (artifactUpdate.rowCount === 0) {
          await client.query(
            `update agent_feed.retention_job_items
                set status = 'skipped', result_code = 'legal_hold_or_terminal',
                    claim_token = null, claim_expires_at = null, updated_at = now()
              where tenant_id = $1 and job_id = $2 and id = $3`, [tenantId, jobId, item.id],
          );
          await this.audit(client, {
            tenantId,
            jobId,
            artifactId: item.artifactId,
            eventType: "retention.item_skipped",
            actor,
            details: { result_code: "legal_hold_or_terminal" },
          });
          return;
        }
        await client.query(
          `update agent_feed.retention_job_items
              set status = 'deleted', result_code = $4,
                  claim_token = null, claim_expires_at = null, updated_at = now()
            where tenant_id = $1 and job_id = $2 and id = $3`, [tenantId, jobId, item.id, boundedCode],
        );
        await this.audit(client, {
          tenantId,
          jobId,
          artifactId: item.artifactId,
          eventType: "retention.item_succeeded",
          actor,
          details: { outcome, result_code: boundedCode },
        });
        return;
      }
      if (outcome === "tombstoned") {
        const artifactUpdate = await client.query(
          `update agent_feed.managed_artifacts
              set status = 'tombstoned', tombstoned_at = coalesce(tombstoned_at, now())
            where tenant_id = $1 and id = $2 and status in ('active', 'retained') and not legal_hold`, [tenantId, item.artifactId],
        );
        if (artifactUpdate.rowCount === 0) {
          await client.query(
            `update agent_feed.retention_job_items
                set status = 'skipped', result_code = 'legal_hold_or_terminal',
                    claim_token = null, claim_expires_at = null, updated_at = now()
              where tenant_id = $1 and job_id = $2 and id = $3`, [tenantId, jobId, item.id],
          );
          await this.audit(client, {
            tenantId,
            jobId,
            artifactId: item.artifactId,
            eventType: "retention.item_skipped",
            actor,
            details: { result_code: "legal_hold_or_terminal" },
          });
          return;
        }
        await client.query(
          `update agent_feed.retention_job_items
              set status = 'tombstoned', result_code = $4,
                  claim_token = null, claim_expires_at = null, updated_at = now()
            where tenant_id = $1 and job_id = $2 and id = $3`, [tenantId, jobId, item.id, boundedCode],
        );
        await this.audit(client, {
          tenantId,
          jobId,
          artifactId: item.artifactId,
          eventType: "retention.item_succeeded",
          actor,
          details: { outcome, result_code: boundedCode },
        });
        return;
      }
      await client.query(
        `update agent_feed.retention_job_items
            set status = 'failed', result_code = $4,
                claim_token = null, claim_expires_at = null, updated_at = now()
          where tenant_id = $1 and job_id = $2 and id = $3`, [tenantId, jobId, item.id, boundedCode],
      );
      await this.audit(client, {
        tenantId,
        jobId,
        artifactId: item.artifactId,
        eventType: "retention.item_failed",
        actor,
        details: { outcome: "failed", result_code: boundedCode },
      });
    });
  }

  private async loadJob(executor: SqlExecutor, tenantId: string, jobId: string, knownRow?: JobRow): Promise<RetentionJob> {
    const jobResult = knownRow === undefined
      ? await executor.query<JobRow>(
        `select id::text, tenant_id, idempotency_key, policy_key, action,
                as_of, requested_by, request_hash, max_items, status,
                candidate_count, completed_count, failed_count, created_at,
                started_at, completed_at
           from agent_feed.retention_jobs
          where tenant_id = $1 and id = $2`, [tenantId, jobId])
      : { rows: [knownRow] } as { rows: JobRow[] };
    const row = jobResult.rows[0];
    if (!row) throw new OperationsError("not_found", "retention job was not found");
    const items = await executor.query<ItemRow>(
      `select id::text, artifact_id::text, artifact_key, storage_ref,
              artifact_class, action, expires_at, status
         from agent_feed.retention_job_items
        where tenant_id = $1 and job_id = $2
        order by expires_at asc, artifact_id asc, id asc`, [tenantId, jobId],
    );
    return jobFromRow(row, items.rows.map(itemFromRow));
  }

  private async audit(executor: SqlExecutor, event: Omit<AuditEvent, "id" | "occurredAt">): Promise<void> {
    const details = object(event.details, "audit.details", 16384);
    await executor.query(
      `insert into agent_feed.operations_audit (
         tenant_id, job_id, artifact_id, event_type, actor, details
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [event.tenantId, event.jobId, event.artifactId, event.eventType, event.actor, JSON.stringify(details)],
    );
  }

  private async withTransaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve the original bounded error */ }
      if (error instanceof OperationsError) throw error;
      throw new OperationsError("storage_error", "operations database operation failed");
    } finally {
      client.release();
    }
  }
}

function artifactClassValue(value: ArtifactClass): ArtifactClass {
  return artifactClass(value);
}
