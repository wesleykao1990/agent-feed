/** Supported schedule families.  Intervals are elapsed UTC durations. */
export type ScheduleKind = "interval" | "cron";

/** The producer path that caused an invocation. */
export type TriggerKind =
  | "scheduled"
  | "manual"
  | "test"
  | "retry"
  | "replay"
  | "backfill"
  | "event"
  | "unknown"
  | "legacy";

/** How a run identifies the expected occurrence it is intended to satisfy. */
export type MatchingMode = "explicit" | "windowed" | "legacy";

/** What to do with expected occurrences that passed their grace window. */
export type MisfirePolicy = "mark_missed" | "fire_latest" | "catch_up";

/** What to do when another invocation is still active. */
export type OverlapPolicy = "allow" | "skip" | "fail_closed";

/** Run lifecycle values relevant to occurrence proof. */
export type RunStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

export const OCCURRENCE_EXPECTATION_SCHEMA_VERSION = "agent-feed.occurrence-expectation.v1" as const;
export const EXPECTED_OCCURRENCE_SCHEMA_VERSION = "agent-feed.expected-occurrence.v1" as const;
export const MAX_MATERIALIZED_OCCURRENCES = 10_000 as const;
export const MAX_CATCH_UP_OCCURRENCES = 100 as const;
export const MAX_OCCURRENCES = MAX_MATERIALIZED_OCCURRENCES;
export const MAX_CATCH_UP = MAX_CATCH_UP_OCCURRENCES;

export interface IntervalSchedule {
  readonly kind: "interval";
  /** Immutable UTC anchor.  Every nominal time is anchorAt + n * interval. */
  readonly anchorAt: string;
  readonly intervalSeconds: number;
}

export interface CronSchedule {
  readonly kind: "cron";
  /** Exactly five standard cron fields: minute hour day-of-month month day-of-week. */
  readonly expression: string;
  /** IANA timezone used only to interpret the cron wall-clock expression. */
  readonly timezone: string;
}

export type Schedule = IntervalSchedule | CronSchedule;

/**
 * Immutable, normalized schedule expectation.  `expectationVersion` is a
 * caller-owned immutable version; changing cadence or policy requires a new
 * version rather than mutating an existing expectation.
 */
export interface ScheduleExpectation {
  readonly schemaVersion: typeof OCCURRENCE_EXPECTATION_SCHEMA_VERSION;
  readonly expectationId: string;
  readonly expectationVersion: string;
  readonly schedule: Schedule;
  readonly graceSeconds: number;
  readonly matchingMode: MatchingMode;
  readonly misfirePolicy: MisfirePolicy;
  readonly overlapPolicy: OverlapPolicy;
  readonly enabled: boolean;
}

/** Canonical input fields are optional to permit normalization of persisted snake_case rows. */
export interface ScheduleExpectationInput {
  readonly schemaVersion?: string;
  readonly id?: string;
  readonly expectationId?: string;
  readonly expectation_id?: string;
  readonly version?: string;
  readonly expectationVersion?: string;
  readonly expectation_version?: string;
  readonly schedule?: ScheduleInput;
  readonly graceSeconds?: number;
  readonly grace_seconds?: number;
  readonly matchingMode?: MatchingMode;
  readonly matching_mode?: MatchingMode;
  readonly misfirePolicy?: MisfirePolicy;
  readonly misfire_policy?: MisfirePolicy;
  readonly overlapPolicy?: OverlapPolicy;
  readonly overlap_policy?: OverlapPolicy;
  readonly enabled?: boolean;
}

export interface IntervalScheduleInput {
  readonly kind?: "interval";
  readonly scheduleKind?: "interval";
  readonly schedule_kind?: "interval";
  readonly anchorAt?: string;
  readonly anchor_at?: string;
  readonly intervalSeconds?: number;
  readonly interval_seconds?: number;
}

export interface CronScheduleInput {
  readonly kind?: "cron";
  readonly scheduleKind?: "cron";
  readonly schedule_kind?: "cron";
  readonly expression?: string;
  readonly cron?: string;
  readonly cronExpression?: string;
  readonly cron_expression?: string;
  readonly timezone?: string;
  readonly timeZone?: string;
  readonly time_zone?: string;
}

export type ScheduleInput = IntervalScheduleInput | CronScheduleInput;

export type Expectation = ScheduleExpectation;

/** One materialized nominal invocation in UTC. */
export interface ExpectedOccurrence {
  readonly schemaVersion: typeof EXPECTED_OCCURRENCE_SCHEMA_VERSION;
  readonly occurrenceKey: string;
  readonly expectationId: string;
  readonly expectationVersion: string;
  /** Nominal scheduled instant; this is also the lower bound of the match window. */
  readonly expectedAt: string;
  /** Explicit alias for integrations that use the scheduler vocabulary. */
  readonly nominalAt: string;
  readonly windowEndsAt: string;
  readonly graceSeconds: number;
}

export type Occurrence = ExpectedOccurrence;

/** A bounded range is inclusive at both UTC endpoints. */
export interface OccurrenceRange {
  readonly from: string;
  readonly to: string;
  /** Optional caller limit. It is always capped at MAX_MATERIALIZED_OCCURRENCES. */
  readonly limit?: number;
}

export interface MaterializeOccurrencesRequest {
  readonly expectation: ScheduleExpectation | ScheduleExpectationInput;
  readonly from: string;
  readonly to: string;
  readonly limit?: number;
}

export interface OccurrenceMaterialization {
  readonly expectation: ScheduleExpectation;
  readonly from: string;
  readonly to: string;
  readonly occurrences: readonly ExpectedOccurrence[];
}

export type DateLike = string;

/** A producer run candidate presented to the pure matcher. */
export interface InvocationCandidate {
  readonly runId: string;
  readonly triggerKind: TriggerKind;
  readonly status: RunStatus;
  /** Invocation start/arrival instant used for window matching. */
  readonly startedAt: string;
  readonly completedAt?: string | null;
  readonly expectationId?: string | null;
  readonly expectationVersion?: string | null;
  /** Explicit occurrence name written by a scheduler/producer. */
  readonly occurrenceKey?: string | null;
  /** Zero is meaningful: a completed zero-finding run is still a success. */
  readonly findingsCount?: number | null;
  readonly invocationState?: "invoked" | "running" | "completed" | "partial" | "failed" | "cancelled";
}

/** Snake_case-compatible candidate input for adapter boundaries. */
export interface InvocationCandidateInput extends Partial<Omit<InvocationCandidate, "runId" | "triggerKind" | "status" | "startedAt">> {
  readonly runId?: string;
  readonly run_id?: string;
  readonly triggerKind?: TriggerKind;
  readonly trigger_kind?: TriggerKind;
  readonly status?: RunStatus;
  readonly runStatus?: RunStatus;
  readonly run_status?: RunStatus;
  readonly startedAt?: string;
  readonly started_at?: string;
  readonly invokedAt?: string;
  readonly invoked_at?: string;
  readonly expectationId?: string | null;
  readonly expectation_id?: string | null;
  readonly expectationVersion?: string | null;
  readonly expectation_version?: string | null;
  readonly occurrenceKey?: string | null;
  readonly occurrence_key?: string | null;
  readonly completedAt?: string | null;
  readonly completed_at?: string | null;
  readonly findingsCount?: number | null;
  readonly findings_count?: number | null;
}

export type RunCandidate = InvocationCandidate;

export type MatchReason =
  | "matched_explicit"
  | "matched_window"
  | "matched_legacy"
  | "missing_scheduled_trigger"
  | "unsupported_trigger"
  | "expectation_mismatch"
  | "version_mismatch"
  | "missing_explicit_occurrence"
  | "explicit_occurrence_mismatch"
  | "occurrence_not_in_candidates"
  | "outside_window"
  | "ambiguous_window"
  | "duplicate_occurrence_key"
  | "already_linked"
  | "invalid_candidate";

export type InvocationOutcome =
  | "running_invocation"
  | "successful_completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "absence";

export interface DerivedInvocationOutcome {
  readonly outcome: InvocationOutcome;
  readonly invocationProven: boolean;
  readonly findingsCount: number | null;
  readonly runId: string | null;
}

export interface MatchRequest {
  readonly expectation: ScheduleExpectation | ScheduleExpectationInput;
  readonly run?: InvocationCandidate | InvocationCandidateInput;
  readonly candidate?: InvocationCandidate | InvocationCandidateInput;
  readonly occurrence?: ExpectedOccurrence;
  readonly occurrences?: readonly ExpectedOccurrence[];
  /** Explicit key can be carried outside the run row by an adapter. */
  readonly explicitOccurrenceKey?: string | null;
  readonly explicit_occurrence_key?: string | null;
  /** Existing links are excluded to prevent accidental duplicate proof. */
  readonly linkedOccurrenceKeys?: readonly string[];
  readonly linked_occurrence_keys?: readonly string[];
}

export interface MatchResult {
  readonly matched: boolean;
  readonly decision: "satisfied" | "rejected";
  readonly reason: MatchReason;
  readonly occurrenceKey: string | null;
  readonly runId: string | null;
  readonly derivedOutcome: DerivedInvocationOutcome;
}

export interface MisfireRequest {
  readonly expectation?: ScheduleExpectation | ScheduleExpectationInput;
  readonly policy?: MisfirePolicy;
  readonly misfirePolicy?: MisfirePolicy;
  readonly misfire_policy?: MisfirePolicy;
  readonly occurrences: readonly ExpectedOccurrence[];
  readonly now: string;
  readonly linkedOccurrenceKeys?: readonly string[];
  readonly linked_occurrence_keys?: readonly string[];
  readonly catchUpLimit?: number;
  readonly catch_up_limit?: number;
}

export type MisfireDecisionKind = "missed" | "eligible" | "deferred" | "linked" | "pending";

export interface MisfireDecision {
  readonly occurrence: ExpectedOccurrence;
  readonly decision: MisfireDecisionKind;
}

export interface MisfireResult {
  readonly policy: MisfirePolicy;
  readonly now: string;
  readonly missed: readonly ExpectedOccurrence[];
  readonly eligible: readonly ExpectedOccurrence[];
  readonly deferred: readonly ExpectedOccurrence[];
  readonly linked: readonly ExpectedOccurrence[];
  readonly pending: readonly ExpectedOccurrence[];
  readonly decisions: readonly MisfireDecision[];
}

export interface PriorInvocation {
  readonly runId: string;
  readonly status?: RunStatus;
  readonly invocationState?: "invoked" | "running" | "completed" | "partial" | "failed" | "cancelled";
  readonly occurrenceKey?: string | null;
}

export interface OverlapRequest {
  readonly policy: OverlapPolicy;
  readonly priorInvocations?: readonly PriorInvocation[];
  readonly prior_invocations?: readonly PriorInvocation[];
  readonly occurrenceKey?: string | null;
}

export interface OverlapResult {
  readonly policy: OverlapPolicy;
  readonly decision: "eligible" | "suppressed" | "conflict";
  readonly reason: "allow_policy" | "skip_policy" | "active_prior_invocation" | "no_active_prior_invocation";
  readonly conflictingRunIds: readonly string[];
}

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly error: OccurrenceCoreErrorShape;
  readonly issues: readonly ValidationIssue[];
}

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type OccurrenceErrorCode =
  | "required_string"
  | "invalid_object"
  | "invalid_schema_version"
  | "required_schedule"
  | "invalid_schedule_kind"
  | "invalid_interval_seconds"
  | "invalid_grace_seconds"
  | "invalid_matching_mode"
  | "invalid_enabled"
  | "invalid_expectation"
  | "invalid_schedule"
  | "invalid_timestamp"
  | "invalid_timezone"
  | "invalid_cron_expression"
  | "invalid_cron_field_count"
  | "unsupported_cron_extension"
  | "invalid_limit"
  | "occurrence_limit_exceeded"
  | "invalid_range"
  | "invalid_candidate"
  | "ambiguous_match"
  | "misfire_limit_exceeded"
  | "invalid_misfire_policy"
  | "invalid_overlap_policy";

export interface OccurrenceCoreErrorShape {
  readonly code: OccurrenceErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class OccurrenceCoreError extends Error {
  readonly code: OccurrenceErrorCode;
  readonly path: string | undefined;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(code: OccurrenceErrorCode, message: string, options: { path?: string; details?: Readonly<Record<string, string | number | boolean>> } = {}) {
    super(message);
    this.name = "OccurrenceCoreError";
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }

  toJSON(): OccurrenceCoreErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
