import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import {
  assertIanaTimezone,
  materializeOccurrences,
  normalizeExpectation,
  normalizeUtcInstant,
  type ScheduleExpectationInput as CoreScheduleExpectationInput,
  type ScheduleExpectation as CoreScheduleExpectation,
  type ExpectedOccurrence as CoreExpectedOccurrence,
} from "@agent-feed/occurrence-core";
import { PersistenceError } from "./errors.ts";
import { payloadHash } from "./hash.ts";
import type {
  ExpectedOccurrence,
  ExpectedOccurrenceInput,
  ExpectedOccurrenceListOptions,
  JsonObject,
  MigrationQuarantineRecord,
  MaterializeScheduleOccurrencesInput,
  OccurrenceLiveness,
  OccurrenceLivenessOptions,
  OccurrenceLivenessStatus,
  OccurrenceMatchingMode,
  OccurrenceTriggerKind,
  PgPool,
  PgTransactionClient,
  RunOccurrenceLink,
  RunOccurrenceLinkInput,
  RunStatus,
  ScheduleExpectationListOptions,
  ScheduleExpectationVersion,
  ScheduleExpectationVersionInput,
  ScheduleKind,
  TrustedRunTriggerContext,
  TrustedRunTriggerContextInput,
} from "./types.ts";

interface DbScheduleRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  schedule_key: string;
  stream_id: string;
  version: number | string;
  schedule_kind: ScheduleKind;
  interval_seconds: number | string | null;
  cron_expression: string | null;
  timezone: string;
  anchor_at: Date | string;
  matching_mode: OccurrenceMatchingMode;
  misfire_policy: ScheduleExpectationVersion["misfire_policy"];
  overlap_policy: ScheduleExpectationVersion["overlap_policy"];
  grace_seconds: number | string;
  enabled: boolean;
  expected_scope: JsonObject;
  owner: string;
  notes: string;
  calculator_version: string;
  tzdata_version: string;
  calculator_provenance: JsonObject;
  tzdata_provenance: JsonObject;
  baseline_next_due_at: Date | string | null;
  created_at: Date | string;
}

interface DbExpectedRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number | string;
  occurrence_key: string;
  ordinal: number | string;
  expected_at: Date | string;
  window_start: Date | string;
  window_end: Date | string;
  metadata: JsonObject;
  created_at: Date | string;
}

interface DbLinkRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number | string;
  occurrence_id: string;
  occurrence_key: string;
  run_id: string;
  wire_run_id: string;
  trigger_kind: OccurrenceTriggerKind;
  matching_mode: OccurrenceMatchingMode;
  matched_at: Date | string;
  link_metadata: JsonObject;
  link_created_at: Date | string;
}

interface DbLivenessRow extends QueryResultRow {
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number | string;
  schedule_enabled: boolean;
  occurrence_id: string;
  occurrence_key: string;
  ordinal: number | string;
  expected_at: Date | string;
  window_start: Date | string;
  window_end: Date | string;
  link_id: string | null;
  wire_run_id: string | null;
  run_status: RunStatus | null;
  trigger_kind: OccurrenceTriggerKind | null;
  matching_mode: OccurrenceMatchingMode | null;
  matched_at: Date | string | null;
  link_metadata: JsonObject | null;
}

interface DbRunRow extends QueryResultRow {
  id: string;
  wire_run_id: string;
  tenant_id: string;
  stream_id: string;
  started_at: Date | string;
}

interface DbTriggerContextRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  wire_run_id: string;
  trigger_kind: OccurrenceTriggerKind;
  schedule_version_id: string | null;
  schedule_key: string | null;
  version: number | string | null;
  trusted_source: string;
  metadata: JsonObject;
  created_at: Date | string;
}

const SCHEDULE_COLUMNS = `id, tenant_id, schedule_key, stream_id, version, schedule_kind,
                         interval_seconds, cron_expression, timezone, anchor_at,
                         matching_mode, misfire_policy, overlap_policy, grace_seconds,
                         enabled, expected_scope, owner, notes, calculator_version,
                         tzdata_version, calculator_provenance, tzdata_provenance,
                         baseline_next_due_at, created_at`;
const SCHEDULE_COLUMNS_QUALIFIED = `sv.id, sv.tenant_id, sv.schedule_key, sv.stream_id, sv.version, sv.schedule_kind,
                                   sv.interval_seconds, sv.cron_expression, sv.timezone, sv.anchor_at,
                                   sv.matching_mode, sv.misfire_policy, sv.overlap_policy, sv.grace_seconds,
                                   sv.enabled, sv.expected_scope, sv.owner, sv.notes, sv.calculator_version,
                                   sv.tzdata_version, sv.calculator_provenance, sv.tzdata_provenance,
                                   sv.baseline_next_due_at, sv.created_at`;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, field: string): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new PersistenceError("invalid_input", `${field} must be an object`, { field });
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 65_536) {
    throw new PersistenceError("invalid_input", `${field} is too large`, { field });
  }
  return value;
}

function encoded(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new PersistenceError("invalid_input", "JSON value is not serializable");
  return result;
}

function asInt(value: number | string, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return result;
}

function asJsonObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return value;
}

function asIso(value: Date | string | null, field: string): string | null {
  if (value === null) return null;
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return result.toISOString();
}

function requiredIso(value: Date | string, field: string): string {
  const result = asIso(value, field);
  if (result === null) throw new PersistenceError("storage_error", `database returned a null ${field}`);
  return result;
}

function dateInput(value: string | Date, field: string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new PersistenceError("invalid_input", `${field} must be a valid ISO date-time`, { field });
  return result;
}

function coreUtc(value: unknown, field: string): string {
  const issues: { code: string; path: string; message: string }[] = [];
  const normalized = normalizeUtcInstant(value, field, issues);
  if (normalized === undefined) {
    throw new PersistenceError("invalid_input", issues[0]?.message ?? `${field} must be an ISO timestamp with an explicit timezone`, { field, source: "@agent-feed/occurrence-core" });
  }
  return normalized;
}

function stringInput(value: unknown, field: string, min = 1, max = 2_048): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new PersistenceError("invalid_input", `${field} must be between ${min} and ${max} characters`, { field });
  }
  return value;
}

function tenant(value: string | undefined): string {
  return stringInput(value ?? "default", "tenant_id", 1, 256);
}

interface ValidatedSchedule {
  id: string;
  tenantId: string;
  scheduleKey: string;
  streamId: string;
  version: number;
  scheduleKind: ScheduleKind;
  intervalSeconds: number | null;
  cronExpression: string | null;
  timezone: string;
  anchorAt: Date;
  baselineNextDueAt: Date | null;
  expectedScope: JsonObject;
  owner: string;
  notes: string;
  calculatorVersion: string;
  tzdataVersion: string;
  calculatorProvenance: JsonObject;
  tzdataProvenance: JsonObject;
  core: CoreScheduleExpectation;
}

function coreValidationError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PersistenceError("invalid_input", `occurrence-core rejected schedule: ${message}`, { source: "@agent-feed/occurrence-core" });
}

function validateSchedule(input: ScheduleExpectationVersionInput): ValidatedSchedule {
  const tenantId = tenant(input.tenant_id);
  const scheduleKey = stringInput(input.schedule_key, "schedule_key", 1, 512);
  const streamId = stringInput(input.stream_id, "stream_id", 1, 512);
  const timezone = stringInput(input.timezone, "timezone", 1, 256);
  const timezoneIssues: { code: string; path: string; message: string }[] = [];
  const normalizedTimezone = assertIanaTimezone(timezone, "timezone", timezoneIssues);
  if (normalizedTimezone === undefined) {
    throw new PersistenceError("invalid_input", timezoneIssues[0]?.message ?? "timezone must be an IANA timezone", { field: "timezone", source: "@agent-feed/occurrence-core" });
  }
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new PersistenceError("invalid_input", "version must be a positive integer", { field: "version" });
  const anchorAt = dateInput(coreUtc(input.anchor_at, "anchor_at"), "anchor_at");
  const baselineNextDueAt = input.baseline_next_due_at === undefined || input.baseline_next_due_at === null
    ? null
    : dateInput(input.baseline_next_due_at, "baseline_next_due_at");
  const expectedScope = object(input.expected_scope, "expected_scope");
  const owner = stringInput(input.owner, "owner", 1, 256);
  const notes = input.notes ?? "";
  if (typeof notes !== "string" || notes.length > 8_192) throw new PersistenceError("invalid_input", "notes is too long", { field: "notes" });
  const calculatorVersion = stringInput(input.calculator_version ?? "agent-feed-occurrence-1", "calculator_version", 1, 256);
  const tzdataVersion = stringInput(input.tzdata_version ?? "database", "tzdata_version", 1, 256);
  const calculatorProvenance = object(input.calculator_provenance, "calculator_provenance");
  const tzdataProvenance = object(input.tzdata_provenance, "tzdata_provenance");
  const id = randomUUID();
  const schedule = input.schedule_kind === "interval"
    ? {
      kind: "interval" as const,
      anchorAt: coreUtc(input.anchor_at, "anchor_at"),
      intervalSeconds: input.interval_seconds as number,
    }
    : input.schedule_kind === "cron"
      ? {
        kind: "cron" as const,
        expression: input.cron_expression as string,
        timezone: normalizedTimezone,
      }
      : null;
  if (schedule === null) throw new PersistenceError("invalid_input", "schedule_kind must be interval or cron");
  let core: CoreScheduleExpectation;
  try {
    core = normalizeExpectation({
      schemaVersion: "agent-feed.occurrence-expectation.v1",
      expectationId: id,
      expectationVersion: String(version),
      schedule,
      graceSeconds: input.grace_seconds,
      matchingMode: input.matching_mode,
      misfirePolicy: input.misfire_policy,
      overlapPolicy: input.overlap_policy,
      enabled: input.enabled ?? true,
    } satisfies CoreScheduleExpectationInput);
  } catch (error) {
    throw coreValidationError(error);
  }
  const normalizedSchedule = core.schedule;
  return {
    id,
    tenantId,
    scheduleKey,
    streamId,
    version,
    scheduleKind: normalizedSchedule.kind,
    intervalSeconds: normalizedSchedule.kind === "interval" ? normalizedSchedule.intervalSeconds : null,
    cronExpression: normalizedSchedule.kind === "cron" ? normalizedSchedule.expression : null,
    timezone: normalizedSchedule.kind === "cron" ? normalizedSchedule.timezone : normalizedTimezone,
    anchorAt: normalizedSchedule.kind === "interval" ? dateInput(normalizedSchedule.anchorAt, "anchor_at") : anchorAt,
    baselineNextDueAt,
    expectedScope,
    owner,
    notes,
    calculatorVersion,
    tzdataVersion,
    calculatorProvenance,
    tzdataProvenance,
    core,
  };
}

function mapDatabaseError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint: unknown }).constraint)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "23505") {
    if (constraint.includes("schedule_expectation_versions") || constraint.includes("schedule_key")) {
      return new PersistenceError("schedule_version_conflict", "schedule expectation version already exists", { constraint });
    }
    if (constraint.includes("run_occurrence_links") && constraint.includes("run_id")) {
      return new PersistenceError("run_already_linked", "run is already linked to an occurrence", { constraint });
    }
    if (constraint.includes("run_occurrence_links") && constraint.includes("occurrence_id")) {
      return new PersistenceError("occurrence_already_linked", "occurrence is already linked to a run", { constraint });
    }
    if (constraint.includes("expected_occurrences")) {
      return new PersistenceError("occurrence_conflict", "expected occurrence identity already exists", { constraint });
    }
    return new PersistenceError("storage_error", "database uniqueness constraint rejected the request", { constraint });
  }
  if (code === "23503") {
    return new PersistenceError("occurrence_not_found", "occurrence or tenant-scoped run does not exist", { constraint });
  }
  if (code === "23514" || code === "22P02") {
    return new PersistenceError("invalid_input", "database rejected the occurrence request", { constraint, message });
  }
  if (code === "P0001") {
    if (/stream does not match/i.test(message)) {
      return new PersistenceError("stream_mismatch", message);
    }
    if (/trusted trigger context.*do not belong|no trusted trigger context/i.test(message)) {
      return new PersistenceError("trigger_context_missing", message);
    }
    if (/legacy expectations require|normal expectations require|trigger|outside the occurrence window/i.test(message)) {
      return new PersistenceError("invalid_trigger_kind", message);
    }
    if (/occurrence.*(window|anchor|aligned)|schedule version.*missing/i.test(message)) {
      return new PersistenceError("occurrence_validation_failed", message);
    }
    return new PersistenceError("invalid_input", message);
  }
  return new PersistenceError("storage_error", "database occurrence operation failed", { message });
}

function scheduleFromRow(row: DbScheduleRow): ScheduleExpectationVersion {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    schedule_key: row.schedule_key,
    stream_id: row.stream_id,
    version: asInt(row.version, "schedule version"),
    schedule_kind: row.schedule_kind,
    interval_seconds: row.interval_seconds === null ? null : asInt(row.interval_seconds, "interval_seconds"),
    cron_expression: row.cron_expression,
    timezone: row.timezone,
    anchor_at: requiredIso(row.anchor_at, "anchor_at"),
    matching_mode: row.matching_mode,
    misfire_policy: row.misfire_policy,
    overlap_policy: row.overlap_policy,
    grace_seconds: asInt(row.grace_seconds, "grace_seconds"),
    enabled: row.enabled,
    expected_scope: asJsonObject(row.expected_scope, "expected_scope"),
    owner: row.owner,
    notes: row.notes,
    calculator_version: row.calculator_version,
    tzdata_version: row.tzdata_version,
    calculator_provenance: asJsonObject(row.calculator_provenance, "calculator_provenance"),
    tzdata_provenance: asJsonObject(row.tzdata_provenance, "tzdata_provenance"),
    baseline_next_due_at: asIso(row.baseline_next_due_at, "baseline_next_due_at"),
    created_at: requiredIso(row.created_at, "created_at"),
  };
}

/**
 * Reconstruct the exact immutable expectation consumed by occurrence-core.
 * Persisted rows are deliberately adapted here instead of reimplementing
 * cron/interval arithmetic in the PostgreSQL repository.
 */
function coreExpectationFromRow(row: DbScheduleRow): CoreScheduleExpectation {
  try {
    return normalizeExpectation({
      schemaVersion: "agent-feed.occurrence-expectation.v1",
      expectationId: row.id,
      expectationVersion: String(asInt(row.version, "schedule version")),
      schedule: row.schedule_kind === "interval"
        ? {
          kind: "interval" as const,
          anchorAt: requiredIso(row.anchor_at, "anchor_at"),
          intervalSeconds: asInt(row.interval_seconds as number | string, "interval_seconds"),
        }
        : {
          kind: "cron" as const,
          expression: stringInput(row.cron_expression, "cron_expression", 1, 512),
          timezone: stringInput(row.timezone, "timezone", 1, 256),
        },
      graceSeconds: asInt(row.grace_seconds, "grace_seconds"),
      matchingMode: row.matching_mode,
      misfirePolicy: row.misfire_policy,
      overlapPolicy: row.overlap_policy,
      enabled: row.enabled,
    } satisfies CoreScheduleExpectationInput);
  } catch (error) {
    throw coreValidationError(error);
  }
}

function coreOccurrenceAt(schedule: CoreScheduleExpectation, expectedAt: Date): CoreExpectedOccurrence {
  const nominal = expectedAt.toISOString();
  try {
    // cron-parser's spring-forward landing instant is observable only when the
    // iterator crosses the DST boundary.  Replaying a bounded 48-hour window
    // preserves the pinned calculator semantics while remaining below the
    // 10,000-row core cap even for one-minute schedules.
    const from = schedule.schedule.kind === "cron"
      ? new Date(expectedAt.getTime() - 48 * 60 * 60 * 1_000).toISOString()
      : nominal;
    const result = materializeOccurrences({
      expectation: schedule,
      from,
      to: nominal,
      limit: schedule.schedule.kind === "cron" ? 2_881 : 1,
    });
    const occurrence = result.occurrences.find((item) => item.expectedAt === nominal);
    if (occurrence === undefined) {
      throw new PersistenceError("occurrence_validation_failed", "expected_at is not a nominal instant generated by the immutable schedule", { expected_at: nominal });
    }
    return occurrence;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("occurrence_validation_failed", `occurrence-core rejected expected_at: ${error instanceof Error ? error.message : String(error)}`, { source: "@agent-feed/occurrence-core" });
  }
}

function assertCoreOccurrence(
  schedule: CoreScheduleExpectation,
  occurrenceKey: string,
  expectedAt: Date,
  windowStart: Date,
  windowEnd: Date,
): void {
  const generated = coreOccurrenceAt(schedule, expectedAt);
  if (generated.occurrenceKey !== occurrenceKey
      || generated.expectedAt !== windowStart.toISOString()
      || generated.windowEndsAt !== windowEnd.toISOString()) {
    throw new PersistenceError("occurrence_validation_failed", "occurrence key, expected_at, or match window does not equal the immutable occurrence-core result", {
      occurrence_key: occurrenceKey,
      expected_at: expectedAt.toISOString(),
      expected_occurrence_key: generated.occurrenceKey,
      expected_window_start: generated.expectedAt,
      expected_window_end: generated.windowEndsAt,
    });
  }
}

function triggerContextFromRow(row: DbTriggerContextRow): TrustedRunTriggerContext {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    run_id: row.wire_run_id,
    trigger_kind: row.trigger_kind,
    schedule_version_id: row.schedule_version_id,
    schedule_key: row.schedule_key,
    version: row.version === null ? null : asInt(row.version, "schedule version"),
    trusted_source: row.trusted_source,
    metadata: asJsonObject(row.metadata, "trigger context metadata"),
    created_at: requiredIso(row.created_at, "trigger context created_at"),
  };
}

function occurrenceFromRow(row: DbExpectedRow): ExpectedOccurrence {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    schedule_version_id: row.schedule_version_id,
    schedule_key: row.schedule_key,
    version: asInt(row.version, "schedule version"),
    occurrence_key: row.occurrence_key,
    ordinal: asInt(row.ordinal, "ordinal"),
    expected_at: requiredIso(row.expected_at, "expected_at"),
    window_start: requiredIso(row.window_start, "window_start"),
    window_end: requiredIso(row.window_end, "window_end"),
    metadata: asJsonObject(row.metadata, "metadata"),
    created_at: requiredIso(row.created_at, "created_at"),
  };
}

function linkFromRow(row: DbLinkRow): RunOccurrenceLink {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    schedule_version_id: row.schedule_version_id,
    schedule_key: row.schedule_key,
    version: asInt(row.version, "schedule version"),
    occurrence_id: row.occurrence_id,
    occurrence_key: row.occurrence_key,
    run_id: row.wire_run_id,
    trigger_kind: row.trigger_kind,
    matching_mode: row.matching_mode,
    matched_at: requiredIso(row.matched_at, "matched_at"),
    metadata: asJsonObject(row.link_metadata, "link metadata"),
    created_at: requiredIso(row.link_created_at, "link created_at"),
  };
}

function occurrenceStatus(row: DbLivenessRow, now: Date): OccurrenceLivenessStatus {
  if (row.run_status !== null) {
    if (row.run_status === "running") return "invoked_running";
    if (row.run_status === "completed") return "satisfied";
    if (row.run_status === "partial") return "invoked_partial";
    if (row.run_status === "failed") return "invoked_failed";
    if (row.run_status === "cancelled") return "invoked_cancelled";
  }
  if (!row.schedule_enabled) return "disabled";
  const start = new Date(requiredIso(row.window_start, "window_start")).getTime();
  const end = new Date(requiredIso(row.window_end, "window_end")).getTime();
  if (now.getTime() < start) return "upcoming";
  if (now.getTime() <= end) return "due";
  return "absent";
}

function livenessFromRow(row: DbLivenessRow, now: Date): OccurrenceLiveness {
  return {
    tenant_id: row.tenant_id,
    schedule_version_id: row.schedule_version_id,
    schedule_key: row.schedule_key,
    version: asInt(row.version, "schedule version"),
    schedule_enabled: row.schedule_enabled,
    occurrence_id: row.occurrence_id,
    occurrence_key: row.occurrence_key,
    ordinal: asInt(row.ordinal, "ordinal"),
    expected_at: requiredIso(row.expected_at, "expected_at"),
    window_start: requiredIso(row.window_start, "window_start"),
    window_end: requiredIso(row.window_end, "window_end"),
    status: occurrenceStatus(row, now),
    run_id: row.wire_run_id,
    run_status: row.run_status,
    trigger_kind: row.trigger_kind,
    matching_mode: row.matching_mode,
    matched_at: asIso(row.matched_at, "matched_at"),
    metadata: row.link_metadata === null ? {} : asJsonObject(row.link_metadata, "link metadata"),
  };
}

/** PostgreSQL boundary for the append-only M7 occurrence sidecar. */
export class PostgresOccurrenceRepository {
  readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async createScheduleExpectationVersion(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    const value = validateSchedule(input);
    return this.withTransaction(async (client) => {
      // Version assignment is deterministic under concurrent creators.  An
      // explicit version still remains immutable and conflicts rather than
      // silently replacing an existing definition.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`occurrence:${value.tenantId}:${value.scheduleKey}`]);
      const result = await client.query<DbScheduleRow>(
        `insert into agent_feed.schedule_expectation_versions (
           id, tenant_id, schedule_key, stream_id, version, schedule_kind, interval_seconds,
           cron_expression, timezone, anchor_at, matching_mode, misfire_policy,
           overlap_policy, grace_seconds, enabled, expected_scope, owner, notes,
           calculator_version, tzdata_version, calculator_provenance,
           tzdata_provenance, baseline_next_due_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16::jsonb, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23)
         returning id, tenant_id, schedule_key, stream_id, version, schedule_kind,
                   interval_seconds, cron_expression, timezone, anchor_at,
                   matching_mode, misfire_policy, overlap_policy, grace_seconds,
                   enabled, expected_scope, owner, notes, calculator_version,
                   tzdata_version, calculator_provenance, tzdata_provenance,
                   baseline_next_due_at, created_at`,
        [
          value.id,
          value.tenantId,
          value.scheduleKey,
          value.streamId,
          value.version,
          value.scheduleKind,
          value.intervalSeconds,
          value.cronExpression,
          value.timezone,
          value.anchorAt,
          value.core.matchingMode,
          value.core.misfirePolicy,
          value.core.overlapPolicy,
          value.core.graceSeconds,
          value.core.enabled,
          encoded(value.expectedScope),
          value.owner,
          value.notes,
          value.calculatorVersion,
          value.tzdataVersion,
          encoded(value.calculatorProvenance),
          encoded(value.tzdataProvenance),
          value.baselineNextDueAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("storage_error", "schedule expectation insert returned no row");
      return scheduleFromRow(row);
    });
  }

  async registerScheduleExpectationVersion(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.createScheduleExpectationVersion(input);
  }

  async create_schedule_expectation_version(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.createScheduleExpectationVersion(input);
  }

  async register_schedule_expectation_version(input: ScheduleExpectationVersionInput): Promise<ScheduleExpectationVersion> {
    return this.createScheduleExpectationVersion(input);
  }

  async getScheduleExpectationVersion(tenantId: string, scheduleKey: string, version: number): Promise<ScheduleExpectationVersion | null> {
    stringInput(scheduleKey, "schedule_key", 1, 512);
    if (!Number.isSafeInteger(version) || version < 1) throw new PersistenceError("invalid_input", "version must be a positive integer");
    const rows = await this.query<DbScheduleRow>(
      `select ${SCHEDULE_COLUMNS}
         from agent_feed.schedule_expectation_versions
        where tenant_id = $1 and schedule_key = $2 and version = $3`,
      [tenant(tenantId), scheduleKey, version],
    );
    const row = rows[0];
    return row ? scheduleFromRow(row) : null;
  }

  async getScheduleExpectationVersionById(tenantId: string, id: string): Promise<ScheduleExpectationVersion | null> {
    stringInput(id, "schedule_version_id", 1, 128);
    const rows = await this.query<DbScheduleRow>(
      `select ${SCHEDULE_COLUMNS}
         from agent_feed.schedule_expectation_versions where tenant_id = $1 and id = $2`,
      [tenant(tenantId), id],
    );
    const row = rows[0];
    return row ? scheduleFromRow(row) : null;
  }

  async get_schedule_expectation_version(tenantId: string, scheduleKey: string, version: number): Promise<ScheduleExpectationVersion | null> {
    return this.getScheduleExpectationVersion(tenantId, scheduleKey, version);
  }

  async get_schedule_expectation_version_by_id(tenantId: string, id: string): Promise<ScheduleExpectationVersion | null> {
    return this.getScheduleExpectationVersionById(tenantId, id);
  }

  async listScheduleExpectationVersions(options: ScheduleExpectationListOptions): Promise<ScheduleExpectationVersion[]> {
    const values: unknown[] = [tenant(options.tenant_id)];
    const predicates = ["tenant_id = $1"];
    if (options.schedule_key !== undefined) {
      values.push(stringInput(options.schedule_key, "schedule_key", 1, 512));
      predicates.push(`schedule_key = $${values.length}`);
    }
    if (options.enabled !== undefined) {
      values.push(options.enabled);
      predicates.push(`enabled = $${values.length}`);
    }
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1_000);
    const offset = Math.max(options.offset ?? 0, 0);
    values.push(limit, offset);
    const rows = await this.query<DbScheduleRow>(
      `select ${SCHEDULE_COLUMNS}
         from agent_feed.schedule_expectation_versions
        where ${predicates.join(" and ")}
        order by schedule_key, version
        limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return rows.map(scheduleFromRow);
  }

  async list_schedule_expectation_versions(options: ScheduleExpectationListOptions): Promise<ScheduleExpectationVersion[]> {
    return this.listScheduleExpectationVersions(options);
  }

  async createExpectedOccurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    const normalized = this.validateOccurrenceInput(input);
    return this.withTransaction(async (client) => this.insertExpectedOccurrenceInTransaction(client, normalized));
  }

  async insertExpectedOccurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.createExpectedOccurrence(input);
  }

  async create_expected_occurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.createExpectedOccurrence(input);
  }

  async insert_expected_occurrence(input: ExpectedOccurrenceInput): Promise<ExpectedOccurrence> {
    return this.createExpectedOccurrence(input);
  }

  async materializeExpectedOccurrences(inputs: ExpectedOccurrenceInput[]): Promise<ExpectedOccurrence[]> {
    if (inputs.length === 0) throw new PersistenceError("invalid_input", "at least one expected occurrence is required");
    const normalized = inputs.map((input) => this.validateOccurrenceInput(input));
    return this.withTransaction(async (client) => {
      const rows: ExpectedOccurrence[] = [];
      for (const input of normalized) rows.push(await this.insertExpectedOccurrenceInTransaction(client, input));
      return rows;
    });
  }

  async materialize_expected_occurrences(inputs: ExpectedOccurrenceInput[]): Promise<ExpectedOccurrence[]> {
    return this.materializeExpectedOccurrences(inputs);
  }

  /**
   * Materialize a bounded UTC range from a persisted immutable schedule.  The
   * pure occurrence-core calculator is the only source of nominal instants,
   * keys, and grace windows; the transaction only allocates stable ordinals
   * and persists those results.
   */
  async materializeScheduleOccurrences(input: MaterializeScheduleOccurrencesInput): Promise<ExpectedOccurrence[]> {
    const tenantId = tenant(input.tenant_id);
    const from = dateInput(coreUtc(input.from, "from"), "from");
    const to = dateInput(coreUtc(input.to, "to"), "to");
    if (from.getTime() > to.getTime()) throw new PersistenceError("invalid_input", "from must be less than or equal to to");
    const scheduleVersionId = input.schedule_version_id === undefined ? null : stringInput(input.schedule_version_id, "schedule_version_id", 1, 128);
    const scheduleKey = input.schedule_key === undefined ? null : stringInput(input.schedule_key, "schedule_key", 1, 512);
    const version = input.version === undefined ? null : input.version;
    if (scheduleVersionId === null && (scheduleKey === null || version === null)) {
      throw new PersistenceError("invalid_input", "materialization requires schedule_version_id or schedule_key plus version");
    }
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new PersistenceError("invalid_input", "version must be a positive integer");
    return this.withTransaction(async (client) => {
      const rows = scheduleVersionId !== null
        ? await client.query<DbScheduleRow>(
          `select ${SCHEDULE_COLUMNS} from agent_feed.schedule_expectation_versions where tenant_id = $1 and id = $2 for update`,
          [tenantId, scheduleVersionId],
        )
        : await client.query<DbScheduleRow>(
          `select ${SCHEDULE_COLUMNS} from agent_feed.schedule_expectation_versions where tenant_id = $1 and schedule_key = $2 and version = $3 for update`,
          [tenantId, scheduleKey, version],
        );
      const schedule = rows.rows[0];
      if (!schedule) throw new PersistenceError("schedule_version_not_found", "schedule expectation version was not found");
      if (scheduleKey !== null && schedule.schedule_key !== scheduleKey) throw new PersistenceError("schedule_version_not_found", "schedule_key does not identify the supplied schedule version");
      if (version !== null && asInt(schedule.version, "schedule version") !== version) throw new PersistenceError("schedule_version_not_found", "version does not identify the supplied schedule version");
      let materialized;
      try {
        materialized = materializeOccurrences({
          expectation: coreExpectationFromRow(schedule),
          from: from.toISOString(),
          to: to.toISOString(),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      } catch (error) {
        throw coreValidationError(error);
      }
      const maxRows = await client.query<{ max_ordinal: number | string | null }>(
        `select max(ordinal) as max_ordinal from agent_feed.expected_occurrences where tenant_id = $1 and schedule_version_id = $2`,
        [tenantId, schedule.id],
      );
      let nextOrdinal = (maxRows.rows[0]?.max_ordinal === null || maxRows.rows[0]?.max_ordinal === undefined)
        ? 0
        : asInt(maxRows.rows[0].max_ordinal, "occurrence ordinal") + 1;
      const result: ExpectedOccurrence[] = [];
      for (const generated of materialized.occurrences) {
        const existing = await client.query<DbExpectedRow>(
          `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
                  sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
                  eo.window_start, eo.window_end, eo.metadata, eo.created_at
             from agent_feed.expected_occurrences eo
             join agent_feed.schedule_expectation_versions sv
               on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
            where eo.tenant_id = $1 and eo.schedule_version_id = $2 and eo.occurrence_key = $3
            for update`,
          [tenantId, schedule.id, generated.occurrenceKey],
        );
        if (existing.rows[0]) {
          const stored = existing.rows[0];
          if (requiredIso(stored.expected_at, "expected_at") !== generated.expectedAt
              || requiredIso(stored.window_start, "window_start") !== generated.expectedAt
              || requiredIso(stored.window_end, "window_end") !== generated.windowEndsAt) {
            throw new PersistenceError("occurrence_validation_failed", "stored occurrence conflicts with occurrence-core materialization", { occurrence_key: generated.occurrenceKey });
          }
          result.push(occurrenceFromRow(stored));
          continue;
        }
        const inserted = await this.insertExpectedOccurrenceInTransaction(client, this.validateOccurrenceInput({
          tenant_id: tenantId,
          schedule_version_id: schedule.id,
          occurrence_key: generated.occurrenceKey,
          ordinal: nextOrdinal,
          expected_at: generated.expectedAt,
          window_start: generated.expectedAt,
          window_end: generated.windowEndsAt,
          metadata: {},
        }));
        nextOrdinal += 1;
        result.push(inserted);
      }
      return result;
    });
  }

  async materialize_schedule_occurrences(input: MaterializeScheduleOccurrencesInput): Promise<ExpectedOccurrence[]> {
    return this.materializeScheduleOccurrences(input);
  }

  async getExpectedOccurrence(tenantId: string, occurrenceId: string): Promise<ExpectedOccurrence | null> {
    const rows = await this.query<DbExpectedRow>(
      `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
              sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
              eo.window_start, eo.window_end, eo.metadata, eo.created_at
         from agent_feed.expected_occurrences eo
         join agent_feed.schedule_expectation_versions sv
           on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
        where eo.tenant_id = $1 and eo.id = $2`,
      [tenant(tenantId), stringInput(occurrenceId, "occurrence_id", 1, 128)],
    );
    const row = rows[0];
    return row ? occurrenceFromRow(row) : null;
  }

  async get_expected_occurrence(tenantId: string, occurrenceId: string): Promise<ExpectedOccurrence | null> {
    return this.getExpectedOccurrence(tenantId, occurrenceId);
  }

  async listExpectedOccurrences(options: ExpectedOccurrenceListOptions): Promise<ExpectedOccurrence[]> {
    const values: unknown[] = [tenant(options.tenant_id)];
    const predicates = ["eo.tenant_id = $1"];
    if (options.schedule_version_id !== undefined) {
      values.push(stringInput(options.schedule_version_id, "schedule_version_id", 1, 128));
      predicates.push(`eo.schedule_version_id = $${values.length}`);
    }
    if (options.schedule_key !== undefined) {
      values.push(stringInput(options.schedule_key, "schedule_key", 1, 512));
      predicates.push(`sv.schedule_key = $${values.length}`);
    }
    if (options.version !== undefined) {
      if (!Number.isSafeInteger(options.version) || options.version < 1) throw new PersistenceError("invalid_input", "version must be a positive integer");
      values.push(options.version);
      predicates.push(`sv.version = $${values.length}`);
    }
    if (options.from !== undefined) {
      values.push(dateInput(options.from, "from"));
      predicates.push(`eo.expected_at >= $${values.length}`);
    }
    if (options.to !== undefined) {
      values.push(dateInput(options.to, "to"));
      predicates.push(`eo.expected_at <= $${values.length}`);
    }
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
    const offset = Math.max(options.offset ?? 0, 0);
    values.push(limit, offset);
    const rows = await this.query<DbExpectedRow>(
      `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
              sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
              eo.window_start, eo.window_end, eo.metadata, eo.created_at
         from agent_feed.expected_occurrences eo
         join agent_feed.schedule_expectation_versions sv
           on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
        where ${predicates.join(" and ")}
        order by eo.expected_at, eo.ordinal, eo.id
        limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return rows.map(occurrenceFromRow);
  }

  async list_expected_occurrences(options: ExpectedOccurrenceListOptions): Promise<ExpectedOccurrence[]> {
    return this.listExpectedOccurrences(options);
  }

  /**
   * Record one trusted, server-side trigger decision for a run.  This method
   * is intentionally outside the protocol/producer boundary: adapters or a
   * scheduler must call it after authenticating the trigger, before linking.
   */
  async recordTrustedRunTriggerContext(input: TrustedRunTriggerContextInput): Promise<TrustedRunTriggerContext> {
    const tenantId = tenant(input.tenant_id);
    const runId = stringInput(input.run_id, "run_id", 1, 512);
    const trustedSource = stringInput(input.trusted_source, "trusted_source", 1, 256);
    const metadata = object(input.metadata, "metadata");
    const triggerKinds: readonly OccurrenceTriggerKind[] = ["scheduled", "legacy", "manual", "test", "retry", "replay", "backfill", "event", "unknown"];
    if (!triggerKinds.includes(input.trigger_kind)) throw new PersistenceError("invalid_trigger_kind", "trigger_kind is not supported");
    const scheduleVersionId = input.schedule_version_id === undefined ? null : stringInput(input.schedule_version_id, "schedule_version_id", 1, 128);
    const scheduleKey = input.schedule_key === undefined ? null : stringInput(input.schedule_key, "schedule_key", 1, 512);
    const version = input.version === undefined ? null : input.version;
    if (input.trigger_kind === "scheduled" || input.trigger_kind === "legacy") {
      if (scheduleVersionId === null && (scheduleKey === null || version === null)) {
        throw new PersistenceError("invalid_input", "scheduled and legacy contexts require a schedule version identity");
      }
      if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new PersistenceError("invalid_input", "version must be a positive integer");
    } else if (scheduleVersionId !== null || scheduleKey !== null || version !== null) {
      throw new PersistenceError("invalid_input", "non-scheduled trigger contexts cannot name a schedule version");
    }
    return this.withTransaction(async (client) => {
      const runRows = await client.query<DbRunRow>(
        `select id, wire_run_id, tenant_id, stream_id, started_at
           from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for update`,
        [tenantId, runId],
      );
      const run = runRows.rows[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${runId} was not found`, { run_id: runId });

      let schedule: DbScheduleRow | undefined;
      if (input.trigger_kind === "scheduled" || input.trigger_kind === "legacy") {
        const scheduleRows = scheduleVersionId !== null
          ? await client.query<DbScheduleRow>(`select ${SCHEDULE_COLUMNS} from agent_feed.schedule_expectation_versions where tenant_id = $1 and id = $2 for share`, [tenantId, scheduleVersionId])
          : await client.query<DbScheduleRow>(`select ${SCHEDULE_COLUMNS} from agent_feed.schedule_expectation_versions where tenant_id = $1 and schedule_key = $2 and version = $3 for share`, [tenantId, scheduleKey, version]);
        schedule = scheduleRows.rows[0];
        if (!schedule) throw new PersistenceError("schedule_version_not_found", "schedule expectation version was not found");
        if (scheduleKey !== null && schedule.schedule_key !== scheduleKey) throw new PersistenceError("schedule_version_not_found", "schedule_key does not identify the supplied schedule version");
        if (version !== null && asInt(schedule.version, "schedule version") !== version) throw new PersistenceError("schedule_version_not_found", "version does not identify the supplied schedule version");
        if (schedule.stream_id !== run.stream_id) throw new PersistenceError("stream_mismatch", "run stream does not match schedule expectation stream", { run_stream_id: run.stream_id, schedule_stream_id: schedule.stream_id });
      }

      const existingRows = await client.query<DbTriggerContextRow>(
        `select c.id, c.tenant_id, r.wire_run_id, c.trigger_kind, c.schedule_version_id,
                sv.schedule_key, sv.version, c.trusted_source, c.metadata, c.created_at
           from agent_feed.run_trigger_contexts c
           join agent_feed.runs r on r.tenant_id = c.tenant_id and r.id = c.run_id
           left join agent_feed.schedule_expectation_versions sv
             on sv.tenant_id = c.tenant_id and sv.id = c.schedule_version_id
          where c.tenant_id = $1 and c.run_id = $2
          for update of c`,
        [tenantId, run.id],
      );
      const existing = existingRows.rows[0];
      if (existing) {
        const same = existing.trigger_kind === input.trigger_kind
          && existing.schedule_version_id === (schedule?.id ?? null)
          && existing.trusted_source === trustedSource
          && payloadHash(asJsonObject(existing.metadata, "trigger context metadata")) === payloadHash(metadata);
        if (!same) throw new PersistenceError("trigger_context_conflict", "run already has a different trusted trigger context", { run_id: runId });
        return triggerContextFromRow(existing);
      }

      const inserted = await client.query<{ id: string }>(
        `insert into agent_feed.run_trigger_contexts (
           tenant_id, run_id, trigger_kind, schedule_version_id, trusted_source, metadata
         ) values ($1, $2, $3, $4, $5, $6::jsonb)
         returning id`,
        [tenantId, run.id, input.trigger_kind, schedule?.id ?? null, trustedSource, encoded(metadata)],
      );
      const contextId = inserted.rows[0]?.id;
      if (!contextId) throw new PersistenceError("storage_error", "trigger context insert returned no row");
      const result = await client.query<DbTriggerContextRow>(
        `select c.id, c.tenant_id, r.wire_run_id, c.trigger_kind, c.schedule_version_id,
                sv.schedule_key, sv.version, c.trusted_source, c.metadata, c.created_at
           from agent_feed.run_trigger_contexts c
           join agent_feed.runs r on r.tenant_id = c.tenant_id and r.id = c.run_id
           left join agent_feed.schedule_expectation_versions sv
             on sv.tenant_id = c.tenant_id and sv.id = c.schedule_version_id
          where c.tenant_id = $1 and c.id = $2`,
        [tenantId, contextId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("storage_error", "trigger context disappeared after insert");
      return triggerContextFromRow(row);
    });
  }

  async record_trusted_run_trigger_context(input: TrustedRunTriggerContextInput): Promise<TrustedRunTriggerContext> {
    return this.recordTrustedRunTriggerContext(input);
  }

  async getTrustedRunTriggerContext(tenantId: string, runId: string): Promise<TrustedRunTriggerContext | null> {
    const rows = await this.query<DbTriggerContextRow>(
      `select c.id, c.tenant_id, r.wire_run_id, c.trigger_kind, c.schedule_version_id,
              sv.schedule_key, sv.version, c.trusted_source, c.metadata, c.created_at
         from agent_feed.run_trigger_contexts c
         join agent_feed.runs r on r.tenant_id = c.tenant_id and r.id = c.run_id
         left join agent_feed.schedule_expectation_versions sv
           on sv.tenant_id = c.tenant_id and sv.id = c.schedule_version_id
        where c.tenant_id = $1 and r.wire_run_id = $2`,
      [tenant(tenantId), stringInput(runId, "run_id", 1, 512)],
    );
    return rows[0] ? triggerContextFromRow(rows[0]) : null;
  }

  async get_trusted_run_trigger_context(tenantId: string, runId: string): Promise<TrustedRunTriggerContext | null> {
    return this.getTrustedRunTriggerContext(tenantId, runId);
  }

  async linkRunToOccurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    const normalized = this.validateLinkInput(input);
    return this.withTransaction(async (client) => {
      const runRows = await client.query<DbRunRow>(
        `select id, wire_run_id, tenant_id, stream_id, started_at
           from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for update`,
        [normalized.tenantId, normalized.runId],
      );
      const run = runRows.rows[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${normalized.runId} was not found`, { run_id: normalized.runId });

      const existingRunLink = await client.query<{ id: string }>(
        `select id from agent_feed.run_occurrence_links where tenant_id = $1 and run_id = $2 for update`,
        [normalized.tenantId, run.id],
      );
      if (existingRunLink.rows[0]) throw new PersistenceError("run_already_linked", "run is already linked to an occurrence", { run_id: normalized.runId });

      const contextRows = await client.query<DbTriggerContextRow>(
        `select c.id, c.tenant_id, r.wire_run_id, c.trigger_kind, c.schedule_version_id,
                sv.schedule_key, sv.version, c.trusted_source, c.metadata, c.created_at
           from agent_feed.run_trigger_contexts c
           join agent_feed.runs r on r.tenant_id = c.tenant_id and r.id = c.run_id
           left join agent_feed.schedule_expectation_versions sv
             on sv.tenant_id = c.tenant_id and sv.id = c.schedule_version_id
          where c.tenant_id = $1 and c.run_id = $2
          for update of c`,
        [normalized.tenantId, run.id],
      );
      const context = contextRows.rows[0];
      if (!context) throw new PersistenceError("trigger_context_missing", "run has no trusted trigger context; protocol runs cannot link directly", { run_id: normalized.runId });

      const schedule = await this.resolveScheduleForLink(client, normalized);
      if (context.schedule_version_id !== schedule.id) {
        throw new PersistenceError("invalid_trigger_kind", "trusted trigger context schedule version does not match link schedule");
      }
      if (schedule.stream_id !== run.stream_id) {
        throw new PersistenceError("stream_mismatch", "run stream does not match schedule expectation stream", { run_stream_id: run.stream_id, schedule_stream_id: schedule.stream_id });
      }
      if (schedule.matching_mode === "legacy") {
        if (context.trigger_kind !== "scheduled" && context.trigger_kind !== "legacy") {
          throw new PersistenceError("invalid_trigger_kind", "legacy expectations require a scheduled or legacy trigger");
        }
      } else if (context.trigger_kind !== "scheduled") {
        throw new PersistenceError("invalid_trigger_kind", "normal expectations require a scheduled trigger");
      }
      let occurrence: DbExpectedRow | undefined;
      if (schedule.matching_mode === "explicit") {
        if (normalized.occurrenceId === null && normalized.occurrenceKey === null) {
          throw new PersistenceError("invalid_input", "explicit matching requires occurrence_id or occurrence_key");
        }
        const predicates = ["eo.tenant_id = $1", "eo.schedule_version_id = $2"];
        const values: unknown[] = [normalized.tenantId, schedule.id];
        if (normalized.occurrenceId !== null) {
          values.push(normalized.occurrenceId);
          predicates.push(`eo.id = $${values.length}`);
        }
        if (normalized.occurrenceKey !== null) {
          values.push(normalized.occurrenceKey);
          predicates.push(`eo.occurrence_key = $${values.length}`);
        }
        const rows = await client.query<DbExpectedRow>(
          `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
                  sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
                  eo.window_start, eo.window_end, eo.metadata, eo.created_at
             from agent_feed.expected_occurrences eo
             join agent_feed.schedule_expectation_versions sv
               on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
            where ${predicates.join(" and ")} for update`,
          values,
        );
        occurrence = rows.rows[0];
        if (!occurrence) throw new PersistenceError("occurrence_not_found", "named occurrence was not found for the schedule version");
      } else {
        if (normalized.occurrenceId !== null || normalized.occurrenceKey !== null) {
          throw new PersistenceError("invalid_input", "windowed and legacy matching use run.started_at and do not accept a named occurrence");
        }
        const startedAt = run.started_at instanceof Date ? run.started_at : new Date(run.started_at);
        const rows = await client.query<DbExpectedRow>(
          `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
                  sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
                  eo.window_start, eo.window_end, eo.metadata, eo.created_at
             from agent_feed.expected_occurrences eo
             join agent_feed.schedule_expectation_versions sv
               on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
            where eo.tenant_id = $1 and eo.schedule_version_id = $2
              and $3::timestamptz >= eo.window_start
              and $3::timestamptz <= eo.window_end
            order by eo.ordinal, eo.id
            for update of eo`,
          [normalized.tenantId, schedule.id, startedAt],
        );
        if (rows.rows.length === 0) throw new PersistenceError("no_matching_occurrence", "run started_at matched no occurrence window");
        if (rows.rows.length !== 1) throw new PersistenceError("ambiguous_occurrence", "run started_at matched multiple occurrence windows");
        occurrence = rows.rows[0];
      }
      if (!occurrence) throw new PersistenceError("occurrence_not_found", "occurrence was not resolved");

      const existingOccurrenceLink = await client.query<{ id: string }>(
        `select id from agent_feed.run_occurrence_links
          where tenant_id = $1 and occurrence_id = $2 for update`,
        [normalized.tenantId, occurrence.id],
      );
      if (existingOccurrenceLink.rows[0]) throw new PersistenceError("occurrence_already_linked", "occurrence is already linked to a run", { occurrence_id: occurrence.id });

      const rows = await client.query<DbLinkRow>(
        `insert into agent_feed.run_occurrence_links (
           tenant_id, schedule_version_id, occurrence_id, run_id,
           trigger_kind, matching_mode, matched_at, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         returning id, tenant_id, schedule_version_id, occurrence_id, run_id,
                   trigger_kind, matching_mode, matched_at, metadata as link_metadata,
                   created_at as link_created_at`,
        [normalized.tenantId, schedule.id, occurrence.id, run.id, context.trigger_kind, schedule.matching_mode, normalized.matchedAt, encoded(normalized.metadata)],
      );
      const row = rows.rows[0];
      if (!row) throw new PersistenceError("storage_error", "occurrence link insert returned no row");
      // The insert projection above intentionally uses internal IDs for the
      // FK.  Fetch the joined public identifiers before returning the receipt.
      const joined = await client.query<DbLinkRow>(
        `select l.id, l.tenant_id, l.schedule_version_id, sv.schedule_key,
                sv.version, l.occurrence_id, eo.occurrence_key,
                l.run_id, r.wire_run_id, l.trigger_kind, l.matching_mode,
                l.matched_at, l.metadata as link_metadata, l.created_at as link_created_at
           from agent_feed.run_occurrence_links l
           join agent_feed.schedule_expectation_versions sv
             on sv.tenant_id = l.tenant_id and sv.id = l.schedule_version_id
           join agent_feed.expected_occurrences eo
             on eo.tenant_id = l.tenant_id
            and eo.schedule_version_id = l.schedule_version_id
            and eo.id = l.occurrence_id
           join agent_feed.runs r
             on r.tenant_id = l.tenant_id and r.id = l.run_id
          where l.tenant_id = $1 and l.id = $2`,
        [normalized.tenantId, row.id],
      );
      const joinedRow = joined.rows[0];
      if (!joinedRow) throw new PersistenceError("storage_error", "occurrence link disappeared after insert");
      return linkFromRow(joinedRow);
    });
  }

  async link_run_to_occurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.linkRunToOccurrence(input);
  }

  async matchRunToOccurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.linkRunToOccurrence(input);
  }

  async match_run_to_occurrence(input: RunOccurrenceLinkInput): Promise<RunOccurrenceLink> {
    return this.linkRunToOccurrence(input);
  }

  async getRunOccurrenceLink(tenantId: string, linkId: string): Promise<RunOccurrenceLink | null> {
    const rows = await this.query<DbLinkRow>(this.linkSelect() + " where l.tenant_id = $1 and l.id = $2", [tenant(tenantId), linkId]);
    const row = rows[0];
    return row ? linkFromRow(row) : null;
  }

  async getRunOccurrenceLinkForRun(tenantId: string, runId: string): Promise<RunOccurrenceLink | null> {
    const rows = await this.query<DbLinkRow>(this.linkSelect() + " where l.tenant_id = $1 and r.wire_run_id = $2", [tenant(tenantId), runId]);
    const row = rows[0];
    return row ? linkFromRow(row) : null;
  }

  async get_run_occurrence_link(tenantId: string, linkId: string): Promise<RunOccurrenceLink | null> {
    return this.getRunOccurrenceLink(tenantId, linkId);
  }

  async get_run_occurrence_link_for_run(tenantId: string, runId: string): Promise<RunOccurrenceLink | null> {
    return this.getRunOccurrenceLinkForRun(tenantId, runId);
  }

  async listRunOccurrenceLinks(tenantId: string, limit = 500, offset = 0): Promise<RunOccurrenceLink[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 2_000);
    const boundedOffset = Math.max(offset, 0);
    const rows = await this.query<DbLinkRow>(
      this.linkSelect() + " where l.tenant_id = $1 order by l.created_at, l.id limit $2 offset $3",
      [tenant(tenantId), boundedLimit, boundedOffset],
    );
    return rows.map(linkFromRow);
  }

  async list_run_occurrence_links(tenantId: string, limit = 500, offset = 0): Promise<RunOccurrenceLink[]> {
    return this.listRunOccurrenceLinks(tenantId, limit, offset);
  }

  async getOccurrenceLiveness(tenantId: string, occurrenceId: string, now: string | Date = new Date()): Promise<OccurrenceLiveness | null> {
    const parsedNow = dateInput(now, "now");
    const rows = await this.query<DbLivenessRow>(this.livenessSelect() + " where eo.tenant_id = $1 and eo.id = $2", [tenant(tenantId), occurrenceId]);
    const row = rows[0];
    return row ? livenessFromRow(row, parsedNow) : null;
  }

  async get_occurrence_liveness(tenantId: string, occurrenceId: string, now: string | Date = new Date()): Promise<OccurrenceLiveness | null> {
    return this.getOccurrenceLiveness(tenantId, occurrenceId, now);
  }

  async listOccurrenceLiveness(options: OccurrenceLivenessOptions): Promise<OccurrenceLiveness[]> {
    const parsedNow = dateInput(options.now ?? new Date(), "now");
    const values: unknown[] = [tenant(options.tenant_id)];
    const predicates = ["eo.tenant_id = $1"];
    if (options.schedule_version_id !== undefined) {
      values.push(stringInput(options.schedule_version_id, "schedule_version_id", 1, 128));
      predicates.push(`eo.schedule_version_id = $${values.length}`);
    }
    if (options.schedule_key !== undefined) {
      values.push(stringInput(options.schedule_key, "schedule_key", 1, 512));
      predicates.push(`sv.schedule_key = $${values.length}`);
    }
    if (options.version !== undefined) {
      if (!Number.isSafeInteger(options.version) || options.version < 1) throw new PersistenceError("invalid_input", "version must be a positive integer");
      values.push(options.version);
      predicates.push(`sv.version = $${values.length}`);
    }
    if (options.include_disabled === false) predicates.push("sv.enabled");
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
    const offset = Math.max(options.offset ?? 0, 0);
    values.push(limit, offset);
    const rows = await this.query<DbLivenessRow>(
      this.livenessSelect() + ` where ${predicates.join(" and ")} order by eo.expected_at, eo.ordinal, eo.id limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return rows.map((row) => livenessFromRow(row, parsedNow));
  }

  async list_occurrence_liveness(options: OccurrenceLivenessOptions): Promise<OccurrenceLiveness[]> {
    return this.listOccurrenceLiveness(options);
  }

  async listMigrationQuarantine(tenantId = "default"): Promise<MigrationQuarantineRecord[]> {
    const rows = await this.query<MigrationQuarantineRecord & QueryResultRow>(
      `select id, tenant_id, stream_id, reason, details, detected_at
         from agent_feed.schedule_expectation_migration_quarantine
        where tenant_id = $1 order by stream_id`,
      [tenant(tenantId)],
    );
    return rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      stream_id: row.stream_id,
      reason: row.reason,
      details: asJsonObject(row.details, "quarantine details"),
      detected_at: requiredIso(row.detected_at, "detected_at"),
    }));
  }

  async list_migration_quarantine(tenantId = "default"): Promise<MigrationQuarantineRecord[]> {
    return this.listMigrationQuarantine(tenantId);
  }

  private validateOccurrenceInput(input: ExpectedOccurrenceInput): {
    tenantId: string;
    scheduleVersionId: string | null;
    scheduleKey: string | null;
    version: number | null;
    occurrenceKey: string;
    ordinal: number;
    expectedAt: Date;
    windowStart: Date;
    windowEnd: Date;
    metadata: JsonObject;
  } {
    const tenantId = tenant(input.tenant_id);
    const scheduleVersionId = input.schedule_version_id === undefined ? null : stringInput(input.schedule_version_id, "schedule_version_id", 1, 128);
    const scheduleKey = input.schedule_key === undefined ? null : stringInput(input.schedule_key, "schedule_key", 1, 512);
    const version = input.version === undefined ? null : input.version;
    if (scheduleVersionId === null && (scheduleKey === null || version === null)) {
      throw new PersistenceError("invalid_input", "an occurrence requires schedule_version_id or schedule_key plus version");
    }
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new PersistenceError("invalid_input", "version must be a positive integer");
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new PersistenceError("invalid_input", "ordinal must be a non-negative integer");
    const expectedAt = dateInput(coreUtc(input.expected_at, "expected_at"), "expected_at");
    const windowStart = dateInput(coreUtc(input.window_start, "window_start"), "window_start");
    const windowEnd = dateInput(coreUtc(input.window_end, "window_end"), "window_end");
    if (windowStart.getTime() > expectedAt.getTime() || expectedAt.getTime() > windowEnd.getTime()) {
      throw new PersistenceError("invalid_input", "expected_at must be inside the occurrence window");
    }
    if (windowEnd.getTime() < windowStart.getTime()) throw new PersistenceError("invalid_input", "window_end must not precede window_start");
    return {
      tenantId,
      scheduleVersionId,
      scheduleKey,
      version,
      occurrenceKey: stringInput(input.occurrence_key, "occurrence_key", 1, 512),
      ordinal: input.ordinal,
      expectedAt,
      windowStart,
      windowEnd,
      metadata: object(input.metadata, "metadata"),
    };
  }

  private async insertExpectedOccurrenceInTransaction(client: PgTransactionClient, input: ReturnType<PostgresOccurrenceRepository["validateOccurrenceInput"]>): Promise<ExpectedOccurrence> {
    let scheduleRows;
    if (input.scheduleVersionId === null) {
      scheduleRows = await client.query<DbScheduleRow>(
        `select ${SCHEDULE_COLUMNS}
           from agent_feed.schedule_expectation_versions
          where tenant_id = $1 and schedule_key = $2 and version = $3 for share`,
        [input.tenantId, input.scheduleKey, input.version],
      );
    } else {
      scheduleRows = await client.query<DbScheduleRow>(
        `select ${SCHEDULE_COLUMNS}
           from agent_feed.schedule_expectation_versions
          where tenant_id = $1 and id = $2 for share`,
        [input.tenantId, input.scheduleVersionId],
      );
    }
    const schedule = scheduleRows.rows[0];
    if (!schedule) throw new PersistenceError("schedule_version_not_found", "schedule expectation version was not found");
    if (input.scheduleKey !== null && input.scheduleKey !== schedule.schedule_key) {
      throw new PersistenceError("schedule_version_not_found", "schedule_key does not identify the supplied schedule version");
    }
    if (input.version !== null && input.version !== asInt(schedule.version, "schedule version")) {
      throw new PersistenceError("schedule_version_not_found", "version does not identify the supplied schedule version");
    }
    assertCoreOccurrence(coreExpectationFromRow(schedule), input.occurrenceKey, input.expectedAt, input.windowStart, input.windowEnd);
    const scheduleId = schedule.id;
    const rows = await client.query<DbExpectedRow>(
      `insert into agent_feed.expected_occurrences (
         tenant_id, schedule_version_id, occurrence_key, ordinal,
         expected_at, window_start, window_end, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       returning id, tenant_id, schedule_version_id, occurrence_key, ordinal,
                 expected_at, window_start, window_end, metadata, created_at`,
      [input.tenantId, scheduleId, input.occurrenceKey, input.ordinal, input.expectedAt, input.windowStart, input.windowEnd, encoded(input.metadata)],
    );
    const row = rows.rows[0];
    if (!row) throw new PersistenceError("storage_error", "expected occurrence insert returned no row");
    const joined = await client.query<DbExpectedRow>(
      `select eo.id, eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
              sv.version, eo.occurrence_key, eo.ordinal, eo.expected_at,
              eo.window_start, eo.window_end, eo.metadata, eo.created_at
         from agent_feed.expected_occurrences eo
         join agent_feed.schedule_expectation_versions sv
           on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
        where eo.tenant_id = $1 and eo.id = $2`,
      [input.tenantId, row.id],
    );
    const joinedRow = joined.rows[0];
    if (!joinedRow) throw new PersistenceError("storage_error", "expected occurrence disappeared after insert");
    return occurrenceFromRow(joinedRow);
  }

  private validateLinkInput(input: RunOccurrenceLinkInput): {
    tenantId: string;
    runId: string;
    scheduleVersionId: string | null;
    scheduleKey: string | null;
    version: number | null;
    occurrenceId: string | null;
    occurrenceKey: string | null;
    matchedAt: Date;
    metadata: JsonObject;
  } {
    const tenantId = tenant(input.tenant_id);
    const runId = stringInput(input.run_id, "run_id", 1, 512);
    const scheduleVersionId = input.schedule_version_id === undefined ? null : stringInput(input.schedule_version_id, "schedule_version_id", 1, 128);
    const scheduleKey = input.schedule_key === undefined ? null : stringInput(input.schedule_key, "schedule_key", 1, 512);
    const version = input.version === undefined ? null : input.version;
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new PersistenceError("invalid_input", "version must be a positive integer");
    const occurrenceId = input.occurrence_id === undefined ? null : stringInput(input.occurrence_id, "occurrence_id", 1, 128);
    const occurrenceKey = input.occurrence_key === undefined ? null : stringInput(input.occurrence_key, "occurrence_key", 1, 512);
    if (scheduleVersionId === null && scheduleKey === null && occurrenceId === null) {
      throw new PersistenceError("invalid_input", "link requires schedule_version_id, schedule_key plus version, or occurrence_id");
    }
    return {
      tenantId,
      runId,
      scheduleVersionId,
      scheduleKey,
      version,
      occurrenceId,
      occurrenceKey,
      matchedAt: input.matched_at === undefined ? new Date() : dateInput(input.matched_at, "matched_at"),
      metadata: object(input.metadata, "metadata"),
    };
  }

  private async resolveScheduleForLink(client: PgTransactionClient, input: ReturnType<PostgresOccurrenceRepository["validateLinkInput"]>): Promise<DbScheduleRow> {
    const fields = SCHEDULE_COLUMNS;
    let rows;
    if (input.scheduleVersionId !== null) {
      rows = await client.query<DbScheduleRow>(`select ${fields} from agent_feed.schedule_expectation_versions where tenant_id = $1 and id = $2 for share`, [input.tenantId, input.scheduleVersionId]);
    } else if (input.scheduleKey !== null && input.version !== null) {
      rows = await client.query<DbScheduleRow>(`select ${fields} from agent_feed.schedule_expectation_versions where tenant_id = $1 and schedule_key = $2 and version = $3 for share`, [input.tenantId, input.scheduleKey, input.version]);
    } else if (input.occurrenceId !== null) {
      rows = await client.query<DbScheduleRow>(
        `select ${SCHEDULE_COLUMNS_QUALIFIED}
           from agent_feed.schedule_expectation_versions sv
           join agent_feed.expected_occurrences eo
             on eo.tenant_id = sv.tenant_id and eo.schedule_version_id = sv.id
          where eo.tenant_id = $1 and eo.id = $2 for update of sv`,
        [input.tenantId, input.occurrenceId],
      );
    } else {
      throw new PersistenceError("invalid_input", "schedule version identity is incomplete");
    }
    const schedule = rows.rows[0];
    if (!schedule) throw new PersistenceError("schedule_version_not_found", "schedule expectation version was not found");
    if (input.scheduleKey !== null && input.scheduleKey !== schedule.schedule_key) {
      throw new PersistenceError("schedule_version_not_found", "schedule_key does not identify the supplied schedule version");
    }
    if (input.version !== null && input.version !== asInt(schedule.version, "schedule version")) {
      throw new PersistenceError("schedule_version_not_found", "version does not identify the supplied schedule version");
    }
    return schedule;
  }

  private linkSelect(): string {
    return `select l.id, l.tenant_id, l.schedule_version_id, sv.schedule_key,
                   sv.version, l.occurrence_id, eo.occurrence_key,
                   l.run_id, r.wire_run_id, l.trigger_kind, l.matching_mode,
                   l.matched_at, l.metadata as link_metadata, l.created_at as link_created_at
              from agent_feed.run_occurrence_links l
              join agent_feed.schedule_expectation_versions sv
                on sv.tenant_id = l.tenant_id and sv.id = l.schedule_version_id
              join agent_feed.expected_occurrences eo
                on eo.tenant_id = l.tenant_id
               and eo.schedule_version_id = l.schedule_version_id
               and eo.id = l.occurrence_id
              join agent_feed.runs r
                on r.tenant_id = l.tenant_id and r.id = l.run_id`;
  }

  private livenessSelect(): string {
    return `select eo.tenant_id, eo.schedule_version_id, sv.schedule_key,
                   sv.version, sv.enabled as schedule_enabled, eo.id as occurrence_id,
                   eo.occurrence_key, eo.ordinal, eo.expected_at, eo.window_start,
                   eo.window_end, l.id as link_id, r.wire_run_id,
                   r.status as run_status, l.trigger_kind, l.matching_mode,
                   l.matched_at, l.metadata as link_metadata
              from agent_feed.expected_occurrences eo
              join agent_feed.schedule_expectation_versions sv
                on sv.tenant_id = eo.tenant_id and sv.id = eo.schedule_version_id
              left join agent_feed.run_occurrence_links l
                on l.tenant_id = eo.tenant_id
               and l.schedule_version_id = eo.schedule_version_id
               and l.occurrence_id = eo.id
              left join agent_feed.runs r
                on r.tenant_id = l.tenant_id and r.id = l.run_id`;
  }

  private async withTransaction<T>(operation: (client: PgTransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve original error */ }
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values as unknown[]);
    return result.rows;
  }
}

export type { Pool };
