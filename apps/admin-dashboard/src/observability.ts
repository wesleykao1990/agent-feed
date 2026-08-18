import {
  ATTEMPT_OUTCOMES,
  FAILURE_REASONS,
  LIVENESS_STATES,
  OBSERVABILITY_FAMILY_DEFINITIONS,
  type MetricFamily,
  type MetricSnapshot,
} from "@agent-feed/operations-observability";
import type { DashboardSnapshot, DashboardSnapshotSource } from "./contracts.ts";
import { DashboardSnapshotError, parseDashboardSnapshot } from "./snapshot.ts";

/** The default freshness contract for an exporter-backed dashboard snapshot. */
export const DEFAULT_DASHBOARD_FRESHNESS_SECONDS = 120;

type Labels = Readonly<Record<string, string>>;

/** Structural public types for integrations that do not import the exporter package. */
export interface ObservabilityMetricSample {
  readonly labels: Labels;
  readonly value: number;
}

export interface ObservabilityMetricFamily {
  readonly name: string;
  readonly samples: readonly ObservabilityMetricSample[];
}

export interface ObservabilityMetricSnapshot {
  readonly protocolVersion: "0.1";
  readonly observedAt: string;
  readonly families: readonly ObservabilityMetricFamily[];
}

const EMPTY_LABELS: Labels = Object.freeze({});

/** Exact family names used by the Agent Feed operations exporter. */
export const FAMILY_NAMES = Object.freeze({
  pending_events: "agent_feed_delivery_pending_events",
  oldest_pending_age_seconds: "agent_feed_delivery_oldest_pending_age_seconds",
  active_leases: "agent_feed_delivery_active_leases",
  expired_leases: "agent_feed_delivery_expired_leases",
  dead_letters_total: "agent_feed_delivery_dead_letters_total",
  delivery_attempts_total: "agent_feed_delivery_attempts_total",
  liveness_streams: "agent_feed_liveness_streams",
  retention_eligible_artifacts: "agent_feed_retention_managed_artifact_rows",
});

export interface DashboardMetricMappingOptions {
  readonly freshnessWindowSeconds?: number;
}

export class DashboardObservabilityMappingError extends Error {
  readonly code = "metric_snapshot_invalid" as const;

  constructor(reason = "invalid") {
    super(`metric_snapshot_invalid:${reason}`);
    this.name = "DashboardObservabilityMappingError";
  }
}

// Compatibility name retained for callers of the first dashboard prototype.
export class DashboardMetricMappingError extends DashboardObservabilityMappingError {
  constructor(reason = "invalid") {
    super(reason);
    this.name = "DashboardMetricMappingError";
  }
}

function invalid(reason: string): never {
  throw new DashboardMetricMappingError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function labelsKey(labels: unknown): string {
  if (!isRecord(labels)) invalid("labels_not_object");
  const entries = Object.entries(labels);
  for (const [key, value] of entries) {
    if (!key || typeof value !== "string") invalid("label_not_string");
  }
  return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function sameLabels(actual: unknown, expected: Labels): boolean {
  try {
    return labelsKey(actual) === labelsKey(expected);
  } catch {
    return false;
  }
}

function expectedLabelsForFamily(name: string): readonly Labels[] {
  if (name === "agent_feed_delivery_attempts_total") {
    return [
      { outcome: "all" },
      ...ATTEMPT_OUTCOMES.map((outcome) => ({ outcome })),
    ];
  }
  if (name === "agent_feed_delivery_failures_total") {
    return [
      { reason: "all" },
      ...FAILURE_REASONS.map((reason) => ({ reason })),
    ];
  }
  if (name === "agent_feed_liveness_streams") {
    return LIVENESS_STATES.map((state) => ({ state }));
  }
  return [EMPTY_LABELS];
}

function validateSample(sample: unknown, expected: Labels, path: string): asserts sample is { labels: Labels; value: number } {
  if (!isRecord(sample) || !sameLabels(sample.labels, expected)) invalid(`${path}:wrong_labels`);
  if (typeof sample.value !== "number" || !Number.isFinite(sample.value) || sample.value < 0) {
    invalid(`${path}:wrong_value`);
  }
}

function validateFamily(value: unknown, index: number): asserts value is MetricFamily {
  const definition = OBSERVABILITY_FAMILY_DEFINITIONS[index];
  if (!definition || !isRecord(value)) invalid(`families[${index}]:missing`);
  if (value.name !== definition.name) invalid(`families[${index}]:wrong_name`);
  if (value.type !== definition.type) invalid(`families[${index}]:wrong_type`);
  if (value.help !== definition.help) invalid(`families[${index}]:wrong_help`);
  if (!Array.isArray(value.samples)) invalid(`families[${index}]:samples_not_array`);
  const expectedLabels = expectedLabelsForFamily(definition.name);
  if (value.samples.length !== expectedLabels.length) invalid(`families[${index}]:wrong_sample_count`);
  const seen = new Set<string>();
  for (let sampleIndex = 0; sampleIndex < expectedLabels.length; sampleIndex += 1) {
    const candidate = value.samples[sampleIndex];
    if (!isRecord(candidate)) invalid(`families[${index}].samples[${sampleIndex}]:not_object`);
    const actualLabels = labelsKey(candidate.labels);
    if (seen.has(actualLabels)) invalid(`families[${index}]:duplicate_labels`);
    seen.add(actualLabels);
    validateSample(candidate, expectedLabels[sampleIndex]!, `families[${index}].samples[${sampleIndex}]`);
  }
}

function validatedSnapshot(value: unknown): MetricSnapshot {
  if (!isRecord(value) || value.protocolVersion !== "0.1" || typeof value.observedAt !== "string") {
    invalid("snapshot_header");
  }
  if (!Array.isArray(value.families) || value.families.length !== OBSERVABILITY_FAMILY_DEFINITIONS.length) {
    invalid("families_count");
  }
  const names = new Set<string>();
  for (let index = 0; index < OBSERVABILITY_FAMILY_DEFINITIONS.length; index += 1) {
    const family = value.families[index];
    validateFamily(family, index);
    if (names.has(family.name)) invalid("duplicate_family");
    names.add(family.name);
  }
  return value as unknown as MetricSnapshot;
}

function sampleValue(family: MetricFamily, expected: Labels): number {
  const matches = family.samples.filter((candidate) => sameLabels(candidate.labels, expected));
  if (matches.length !== 1) invalid(`family:${family.name}:missing_or_duplicate_labels`);
  return matches[0]!.value;
}

function familyByName(snapshot: MetricSnapshot, name: string): MetricFamily {
  const index = OBSERVABILITY_FAMILY_DEFINITIONS.findIndex((definition) => definition.name === name);
  if (index < 0) invalid(`family:${name}:unknown`);
  const family = snapshot.families[index];
  if (!family) invalid(`family:${name}:missing`);
  return family;
}

/**
 * Convert the canonical operations MetricSnapshot into the dashboard's
 * deliberately smaller aggregate. The full family order, names, HELP text,
 * sample counts, and labels are checked before any value is selected. This is
 * important for `state=overdue`: a missing, duplicate, or relabelled overdue
 * series must fail closed rather than silently becoming zero.
 */
export function metricSnapshotToDashboardSnapshot(
  value: unknown,
  freshnessWindowOrOptions: number | DashboardMetricMappingOptions = DEFAULT_DASHBOARD_FRESHNESS_SECONDS,
): DashboardSnapshot {
  const snapshot = validatedSnapshot(value);
  const freshnessWindowSeconds = typeof freshnessWindowOrOptions === "number"
    ? freshnessWindowOrOptions
    : freshnessWindowOrOptions.freshnessWindowSeconds ?? DEFAULT_DASHBOARD_FRESHNESS_SECONDS;
  if (!Number.isSafeInteger(freshnessWindowSeconds) || freshnessWindowSeconds < 1 || freshnessWindowSeconds > 86_400) {
    invalid("freshness_window");
  }
  const attempts = familyByName(snapshot, FAMILY_NAMES.delivery_attempts_total);
  const liveness = familyByName(snapshot, FAMILY_NAMES.liveness_streams);
  try {
    return parseDashboardSnapshot({
      schemaVersion: 1,
      generatedAt: snapshot.observedAt,
      freshnessWindowSeconds,
      metrics: {
        pending_events: sampleValue(familyByName(snapshot, FAMILY_NAMES.pending_events), EMPTY_LABELS),
        oldest_pending_age_seconds: sampleValue(familyByName(snapshot, FAMILY_NAMES.oldest_pending_age_seconds), EMPTY_LABELS),
        active_leases: sampleValue(familyByName(snapshot, FAMILY_NAMES.active_leases), EMPTY_LABELS),
        expired_leases: sampleValue(familyByName(snapshot, FAMILY_NAMES.expired_leases), EMPTY_LABELS),
        dead_letters_total: sampleValue(familyByName(snapshot, FAMILY_NAMES.dead_letters_total), EMPTY_LABELS),
        delivery_attempts_total: sampleValue(attempts, { outcome: "all" }),
        overdue_streams: sampleValue(liveness, { state: "overdue" }),
        retention_eligible_artifacts: sampleValue(familyByName(snapshot, FAMILY_NAMES.retention_eligible_artifacts), EMPTY_LABELS),
      },
    });
  } catch (error) {
    if (error instanceof DashboardObservabilityMappingError) throw error;
    throw new DashboardMetricMappingError("dashboard_snapshot_invalid");
  }
}

/** Compatibility alias for the original mapping API. */
export function mapMetricSnapshotToDashboardSnapshot(
  value: unknown,
  options: DashboardMetricMappingOptions = {},
): DashboardSnapshot {
  return metricSnapshotToDashboardSnapshot(value, options);
}

/** A source adapter that performs the mapping at the dashboard boundary. */
export class MetricSnapshotDashboardSource implements DashboardSnapshotSource {
  readonly #source: { readMetricSnapshot(): Promise<unknown> };
  readonly #freshnessWindowSeconds: number;

  constructor(source: { readMetricSnapshot(): Promise<unknown> }, freshnessWindowSeconds = DEFAULT_DASHBOARD_FRESHNESS_SECONDS) {
    this.#source = source;
    this.#freshnessWindowSeconds = freshnessWindowSeconds;
  }

  async read(): Promise<unknown> {
    try {
      return metricSnapshotToDashboardSnapshot(await this.#source.readMetricSnapshot(), this.#freshnessWindowSeconds);
    } catch (error) {
      if (error instanceof DashboardSnapshotError) throw error;
      throw new DashboardSnapshotError();
    }
  }
}

export { expectedLabelsForFamily };
