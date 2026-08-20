import { CronExpressionParser } from "cron-parser";
import {
  OCCURRENCE_EXPECTATION_SCHEMA_VERSION,
  OccurrenceCoreError,
  type CronSchedule,
  type IntervalSchedule,
  type IntervalScheduleInput,
  type MatchingMode,
  type MisfirePolicy,
  type OverlapPolicy,
  type Schedule,
  type ScheduleExpectation,
  type ScheduleExpectationInput,
  type CronScheduleInput,
  type ScheduleInput,
  type ValidationIssue,
  type ValidationResult,
} from "./types.ts";

type NormalizedExpectation = ScheduleExpectation;

const ALLOWED_MATCHING_MODES: readonly MatchingMode[] = ["explicit", "windowed", "legacy"];
const ALLOWED_MISFIRE_POLICIES: readonly MisfirePolicy[] = ["mark_missed", "fire_latest", "catch_up"];
const ALLOWED_OVERLAP_POLICIES: readonly OverlapPolicy[] = ["allow", "skip", "fail_closed"];
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;
const CRON_FORBIDDEN_PATTERN = /[@?#LWH]/i;

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function requireString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ code: "required_string", path, message: `${path} must be a non-empty string` });
    return undefined;
  }
  return value.trim();
}

/** Parse an ISO instant and return its canonical UTC representation. */
export function normalizeUtcInstant(value: unknown, path: string, issues: ValidationIssue[] = []): string | undefined {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    issues.push({ code: "invalid_timestamp", path, message: `${path} must be an ISO timestamp with an explicit timezone` });
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    issues.push({ code: "invalid_timestamp", path, message: `${path} is not a valid instant` });
    return undefined;
  }
  return new Date(milliseconds).toISOString();
}

export function parseUtcInstant(value: string, path: string): number {
  const issues: ValidationIssue[] = [];
  const normalized = normalizeUtcInstant(value, path, issues);
  if (normalized === undefined) {
    const issue = issues[0];
    throw new OccurrenceCoreError("invalid_timestamp", issue?.message ?? `invalid ${path}`, { path });
  }
  return Date.parse(normalized);
}

export function assertIanaTimezone(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const timezone = requireString(value, path, issues);
  if (timezone === undefined) return undefined;
  try {
    // Constructing the formatter is the platform-supported IANA validation
    // boundary. It rejects abbreviations and unknown zone identifiers.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    issues.push({ code: "invalid_timezone", path, message: `${path} must be an IANA timezone` });
    return undefined;
  }
  return timezone;
}

function validateCron(expressionValue: unknown, timezoneValue: unknown, issues: ValidationIssue[]): CronSchedule | undefined {
  const expression = requireString(expressionValue, "schedule.expression", issues);
  const timezone = assertIanaTimezone(timezoneValue, "schedule.timezone", issues);
  if (expression === undefined) return undefined;
  if (CRON_FORBIDDEN_PATTERN.test(expression)) {
    issues.push({ code: "unsupported_cron_extension", path: "schedule.expression", message: "cron macros and ?, L, W, #, and H extensions are not supported" });
    return undefined;
  }
  const fields = expression.split(/\s+/u);
  if (fields.length !== 5) {
    issues.push({ code: "invalid_cron_field_count", path: "schedule.expression", message: "cron expression must contain exactly five fields" });
    return undefined;
  }
  if (timezone === undefined) return undefined;
  try {
    // The explicit field count above prevents cron-parser's optional seconds
    // field. Standard five-field cron permits both day-of-month and day-of-
    // week restrictions (with their usual OR semantics), so do not enable the
    // parser's stricter mutual-exclusion mode here.
    CronExpressionParser.parse(expression, {
      tz: timezone,
      strict: false,
      currentDate: new Date(0),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "cron-parser rejected the expression";
    issues.push({ code: "invalid_cron_expression", path: "schedule.expression", message: detail });
    return undefined;
  }
  return { kind: "cron", expression, timezone };
}

function validateInterval(input: IntervalScheduleInput, issues: ValidationIssue[]): IntervalSchedule | undefined {
  const anchorValue = firstDefined(input.anchorAt, input.anchor_at);
  const anchorAt = normalizeUtcInstant(anchorValue, "schedule.anchorAt", issues);
  const intervalSeconds = firstDefined(input.intervalSeconds, input.interval_seconds);
  if (!Number.isSafeInteger(intervalSeconds) || (intervalSeconds as number) <= 0) {
    issues.push({ code: "invalid_interval_seconds", path: "schedule.intervalSeconds", message: "intervalSeconds must be a positive safe integer" });
  }
  if (anchorAt === undefined || !Number.isSafeInteger(intervalSeconds) || (intervalSeconds as number) <= 0) return undefined;
  return { kind: "interval", anchorAt, intervalSeconds: intervalSeconds as number };
}

function normalizeSchedule(input: ScheduleInput | undefined, issues: ValidationIssue[]): Schedule | undefined {
  if (input === undefined || input === null || typeof input !== "object") {
    issues.push({ code: "required_schedule", path: "schedule", message: "schedule is required" });
    return undefined;
  }
  const kind = firstDefined(input.kind, input.scheduleKind, input.schedule_kind);
  if (kind === "interval") return validateInterval(input as IntervalScheduleInput, issues);
  if (kind === "cron") {
    const cronInput = input as CronScheduleInput;
    return validateCron(firstDefined(cronInput.expression, cronInput.cron, cronInput.cronExpression, cronInput.cron_expression), firstDefined(cronInput.timezone, cronInput.timeZone, cronInput.time_zone), issues);
  }
  issues.push({ code: "invalid_schedule_kind", path: "schedule.kind", message: "schedule.kind must be interval or cron" });
  return undefined;
}

function issueError(issues: readonly ValidationIssue[]): OccurrenceCoreError {
  const issue = issues[0];
  const code = issue?.code;
  const knownCodes = new Set<import("./types.ts").OccurrenceErrorCode>([
    "required_string", "invalid_object", "invalid_schema_version", "required_schedule", "invalid_schedule_kind", "invalid_interval_seconds", "invalid_grace_seconds", "invalid_matching_mode", "invalid_enabled",
    "invalid_expectation", "invalid_schedule", "invalid_timestamp", "invalid_timezone", "invalid_cron_expression", "invalid_cron_field_count", "unsupported_cron_extension", "invalid_limit", "occurrence_limit_exceeded", "invalid_range", "invalid_candidate", "ambiguous_match", "misfire_limit_exceeded", "invalid_misfire_policy", "invalid_overlap_policy",
  ]);
  const errorCode = code !== undefined && knownCodes.has(code as import("./types.ts").OccurrenceErrorCode) ? code as import("./types.ts").OccurrenceErrorCode : "invalid_expectation";
  return new OccurrenceCoreError(errorCode, issue?.message ?? "invalid schedule expectation", issue === undefined ? {} : { path: issue.path });
}

/** Validate and normalize a schedule expectation without mutating caller input. */
export function validateExpectation(input: ScheduleExpectationInput): ValidationResult<NormalizedExpectation> {
  const issues: ValidationIssue[] = [];
  if (input === null || typeof input !== "object") {
    const error = new OccurrenceCoreError("invalid_expectation", "expectation must be an object");
    return { ok: false, error: error.toJSON(), issues: [{ code: "invalid_object", path: "expectation", message: error.message }] };
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== OCCURRENCE_EXPECTATION_SCHEMA_VERSION) {
    issues.push({ code: "invalid_schema_version", path: "schemaVersion", message: `schemaVersion must be ${OCCURRENCE_EXPECTATION_SCHEMA_VERSION}` });
  }
  const expectationId = requireString(firstDefined(input.expectationId, input.expectation_id, input.id), "expectationId", issues);
  const expectationVersion = requireString(firstDefined(input.expectationVersion, input.expectation_version, input.version), "expectationVersion", issues);
  const schedule = normalizeSchedule(input.schedule, issues);
  const graceSeconds = firstDefined(input.graceSeconds, input.grace_seconds);
  if (!Number.isSafeInteger(graceSeconds) || (graceSeconds as number) < 0) {
    issues.push({ code: "invalid_grace_seconds", path: "graceSeconds", message: "graceSeconds must be a non-negative safe integer" });
  }
  const matchingMode = firstDefined(input.matchingMode, input.matching_mode);
  if (!ALLOWED_MATCHING_MODES.includes(matchingMode as MatchingMode)) {
    issues.push({ code: "invalid_matching_mode", path: "matchingMode", message: "matchingMode must be explicit, windowed, or legacy" });
  }
  const misfirePolicy = firstDefined(input.misfirePolicy, input.misfire_policy);
  if (!ALLOWED_MISFIRE_POLICIES.includes(misfirePolicy as MisfirePolicy)) {
    issues.push({ code: "invalid_misfire_policy", path: "misfirePolicy", message: "misfirePolicy is not supported" });
  }
  const overlapPolicy = firstDefined(input.overlapPolicy, input.overlap_policy);
  if (!ALLOWED_OVERLAP_POLICIES.includes(overlapPolicy as OverlapPolicy)) {
    issues.push({ code: "invalid_overlap_policy", path: "overlapPolicy", message: "overlapPolicy is not supported" });
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    issues.push({ code: "invalid_enabled", path: "enabled", message: "enabled must be boolean" });
  }
  if (issues.length > 0 || expectationId === undefined || expectationVersion === undefined || schedule === undefined) {
    return { ok: false, error: issueError(issues).toJSON(), issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: OCCURRENCE_EXPECTATION_SCHEMA_VERSION,
      expectationId,
      expectationVersion,
      schedule,
      graceSeconds: graceSeconds as number,
      matchingMode: matchingMode as MatchingMode,
      misfirePolicy: misfirePolicy as MisfirePolicy,
      overlapPolicy: overlapPolicy as OverlapPolicy,
      enabled: input.enabled ?? true,
    },
  };
}

/** Validate and throw a structured OccurrenceCoreError on invalid input. */
export function normalizeExpectation(input: ScheduleExpectationInput | ScheduleExpectation): ScheduleExpectation {
  const result = validateExpectation(input);
  if (!result.ok) {
    throw new OccurrenceCoreError(result.error.code as import("./types.ts").OccurrenceErrorCode, result.error.message, result.error.path === undefined ? {} : { path: result.error.path });
  }
  return result.value;
}

export const validateScheduleExpectation = validateExpectation;
export const normalizeScheduleExpectation = normalizeExpectation;
