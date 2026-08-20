import {
  CONTROL_PLANE_SCHEMA_VERSION,
  ControlPlaneContractError,
  FAILURE_LAYERS,
  type AssessmentState,
  type ControlPlaneHealth,
  type ControlPlaneSnapshot,
  type ControlPlaneSnapshotInput,
  type ControlPlaneSnapshotState,
  type CountGroup,
  type DeliveryState,
  type FailureLayer,
  type JobState,
  type OccurrenceState,
  type RunState,
} from "./types.ts";

const JOB_STATES = ["draft", "shadow", "active", "paused", "retired"] as const;
const OCCURRENCE_STATES = ["pending", "absent", "running", "completed_zero", "completed", "partial", "failed", "cancelled"] as const;
const RUN_STATES = ["running", "completed", "partial", "failed", "cancelled"] as const;
const ASSESSMENT_STATES = ["passed", "failed", "inconclusive", "unknown"] as const;
const DELIVERY_STATES = ["queued", "leased", "retry", "acknowledged", "dead_letter"] as const;
const MAX_COUNT = 1_000_000_000_000;
const MAX_FRESHNESS = 86_400;
const MAX_CLOCK_SKEW = 60;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function count(value: unknown, path: string, issues: string[]): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    issues.push(`${path}:nonnegative_bounded_safe_integer_required`);
    return 0;
  }
  return value as number;
}

function group<T extends string>(value: CountGroup<T>, states: readonly T[], path: string, issues: string[]): CountGroup<T> {
  if (!value || typeof value !== "object" || !value.byState || typeof value.byState !== "object") {
    issues.push(`${path}:count_group_required`);
    return { total: 0, byState: Object.fromEntries(states.map((state) => [state, 0])) as Record<T, number> };
  }
  const byState = Object.fromEntries(states.map((state) => [state, count(value.byState[state], `${path}.byState.${state}`, issues)])) as Record<T, number>;
  const total = count(value.total, `${path}.total`, issues);
  const sum = Object.values(byState as Record<string, number>).reduce((result, item) => result + item, 0);
  if (sum !== total) issues.push(`${path}:total_does_not_reconcile`);
  for (const key of Object.keys(value.byState)) if (!(states as readonly string[]).includes(key)) issues.push(`${path}.byState.${key}:unknown_state`);
  return { total, byState };
}

function instant(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    issues.push("generatedAt:strict_utc_timestamp_required"); return "1970-01-01T00:00:00.000Z";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) { issues.push("generatedAt:invalid_timestamp"); return "1970-01-01T00:00:00.000Z"; }
  return date.toISOString();
}

function health(snapshot: Omit<ControlPlaneSnapshot, "health">): ControlPlaneHealth {
  if (snapshot.failures.gateway > 0 || snapshot.failures.provider > 0) return "critical";
  if (snapshot.occurrences.byState.absent > 0 || snapshot.deliveries.byState.dead_letter > 0 || snapshot.failures.execution > 0) return "critical";
  if (snapshot.runs.byState.partial > 0 || snapshot.assessments.byState.failed > 0 || snapshot.failures.validation > 0 || snapshot.failures.delivery > 0 || snapshot.deliveries.byState.retry > 0) return "degraded";
  if (snapshot.jobs.total === 0) return "unknown";
  return "healthy";
}

export function normalizeControlPlaneSnapshot(input: ControlPlaneSnapshotInput): ControlPlaneSnapshot {
  const issues: string[] = [];
  const allowedFields = new Set(["schemaVersion", "tenantId", "generatedAt", "freshnessWindowSeconds", "jobs", "occurrences", "runs", "assessments", "deliveries", "failures"]);
  for (const key of Object.keys(input)) if (!allowedFields.has(key)) issues.push(`${key}:unknown_field`);
  if (input.schemaVersion !== undefined && input.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION) issues.push("schemaVersion:unsupported");
  if (typeof input.tenantId !== "string" || !TENANT.test(input.tenantId)) issues.push("tenantId:invalid_scope");
  const freshnessWindowSeconds = count(input.freshnessWindowSeconds, "freshnessWindowSeconds", issues);
  if (freshnessWindowSeconds < 1 || freshnessWindowSeconds > MAX_FRESHNESS) issues.push("freshnessWindowSeconds:out_of_range");
  const failureMap = Object.fromEntries(FAILURE_LAYERS.map((layer) => [layer, 0])) as Record<FailureLayer, number>;
  const seen = new Set<FailureLayer>();
  for (const [index, failure] of input.failures.entries()) {
    if (!(FAILURE_LAYERS as readonly string[]).includes(failure?.layer)) { issues.push(`failures[${index}].layer:invalid`); continue; }
    if (seen.has(failure.layer)) issues.push(`failures[${index}].layer:duplicate`);
    seen.add(failure.layer);
    failureMap[failure.layer] = count(failure.count, `failures[${index}].count`, issues);
  }
  const base: Omit<ControlPlaneSnapshot, "health"> = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    tenantId: input.tenantId,
    generatedAt: instant(input.generatedAt, issues),
    freshnessWindowSeconds,
    jobs: group<JobState>(input.jobs, JOB_STATES, "jobs", issues),
    occurrences: group<OccurrenceState>(input.occurrences, OCCURRENCE_STATES, "occurrences", issues),
    runs: group<RunState>(input.runs, RUN_STATES, "runs", issues),
    assessments: group<AssessmentState>(input.assessments, ASSESSMENT_STATES, "assessments", issues),
    deliveries: group<DeliveryState>(input.deliveries, DELIVERY_STATES, "deliveries", issues),
    failures: failureMap,
  };
  if (issues.length > 0) throw new ControlPlaneContractError(issues);
  return Object.freeze({ ...base, health: health(base) });
}

export function controlPlaneSnapshotState(input: ControlPlaneSnapshotInput, nowMs = Date.now()): ControlPlaneSnapshotState {
  const snapshot = normalizeControlPlaneSnapshot(input);
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (generatedMs - nowMs > MAX_CLOCK_SKEW * 1000) throw new ControlPlaneContractError(["generatedAt:future_clock_skew"]);
  const ageSeconds = Math.max(0, (nowMs - generatedMs) / 1000);
  return { snapshot, ageSeconds, stale: ageSeconds > snapshot.freshnessWindowSeconds };
}
