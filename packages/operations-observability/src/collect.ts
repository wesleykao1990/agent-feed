import {
  ATTEMPT_OUTCOMES,
  FAILURE_REASONS,
  LIVENESS_STATES,
  type AttemptOutcome,
  type DeliveryMetricInput,
  type FailureReason,
  type LivenessState,
  type MetricFamily,
  type MetricLimits,
  type MetricSample,
  type MetricSnapshot,
} from "./types.ts";

export const DEFAULT_METRIC_LIMITS: Required<MetricLimits> = Object.freeze({
  maxCount: 9_000_000_000_000,
  maxAgeSeconds: 315_360_000,
  maxBytes: 9_000_000_000_000_000,
  maxCostUsd: 1_000_000_000_000,
});

export interface ObservabilityFamilyDefinition {
  readonly name: string;
  readonly type: MetricFamily["type"];
  readonly help: string;
}

export const OBSERVABILITY_FAMILY_DEFINITIONS: readonly ObservabilityFamilyDefinition[] = Object.freeze([
  Object.freeze({ name: "agent_feed_delivery_pending_events", type: "gauge", help: "Number of delivery rows currently awaiting a terminal outcome." }),
  Object.freeze({ name: "agent_feed_delivery_oldest_pending_age_seconds", type: "gauge", help: "Age in seconds of the oldest pending delivery row; zero means no pending row." }),
  Object.freeze({ name: "agent_feed_delivery_active_leases", type: "gauge", help: "Number of delivery rows currently leased by workers." }),
  Object.freeze({ name: "agent_feed_delivery_expired_leases", type: "gauge", help: "Number of delivery leases past their expiry and eligible for recovery." }),
  Object.freeze({ name: "agent_feed_delivery_attempts_total", type: "counter", help: "Cumulative delivery attempts, split only by a fixed outcome vocabulary." }),
  Object.freeze({ name: "agent_feed_delivery_failures_total", type: "counter", help: "Cumulative delivery failures, split only by a fixed redacted reason vocabulary." }),
  Object.freeze({ name: "agent_feed_delivery_retries_total", type: "counter", help: "Cumulative retry transitions." }),
  Object.freeze({ name: "agent_feed_delivery_acknowledgements_total", type: "counter", help: "Cumulative acknowledgement transitions." }),
  Object.freeze({ name: "agent_feed_delivery_dead_letters_total", type: "counter", help: "Cumulative dead-letter transitions." }),
  Object.freeze({ name: "agent_feed_liveness_streams", type: "gauge", help: "Expected streams grouped by the fixed liveness state vocabulary." }),
  Object.freeze({ name: "agent_feed_liveness_expected_streams", type: "gauge", help: "Number of expected streams included in the liveness snapshot." }),
  Object.freeze({ name: "agent_feed_storage_outbox_rows", type: "gauge", help: "Current number of immutable outbox event rows." }),
  Object.freeze({ name: "agent_feed_storage_delivery_rows", type: "gauge", help: "Current number of delivery fan-out rows." }),
  Object.freeze({ name: "agent_feed_storage_attempt_rows", type: "gauge", help: "Current number of retained delivery attempt rows." }),
  Object.freeze({ name: "agent_feed_storage_bytes", type: "gauge", help: "Current estimated bytes occupied by Agent Feed operational tables." }),
  Object.freeze({ name: "agent_feed_retention_managed_artifact_rows", type: "gauge", help: "Managed external artifact rows eligible for the configured retention job; immutable protocol and delivery rows are excluded." }),
  Object.freeze({ name: "agent_feed_retention_managed_artifact_bytes", type: "gauge", help: "Estimated bytes of managed external artifacts eligible for the configured retention job; immutable protocol and delivery rows are excluded." }),
  Object.freeze({ name: "agent_feed_delivery_egress_bytes_total", type: "counter", help: "Cumulative estimated delivery egress bytes used for bounded cost accounting." }),
  Object.freeze({ name: "agent_feed_delivery_estimated_cost_usd_total", type: "counter", help: "Cumulative estimated delivery cost in USD; this is an operational estimate, not a billing record." }),
]);

export const OBSERVABILITY_FAMILY_NAMES: readonly string[] = Object.freeze(
  OBSERVABILITY_FAMILY_DEFINITIONS.map((definition) => definition.name),
);

const EMPTY_LABELS: Readonly<Record<string, string>> = Object.freeze({});

function invalid(field: string, reason: string): never {
  throw new Error(`invalid_metric_input:${field}:${reason}`);
}

function count(value: unknown, field: string, limit: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(field, "expected_non_negative_integer");
  }
  return Math.min(value, limit);
}

function amount(value: unknown, field: string, limit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(field, "expected_non_negative_number");
  }
  return Math.min(value, limit);
}

function optionalCount(value: unknown, field: string, limit: number): number {
  return value === undefined ? 0 : count(value, field, limit);
}

function optionalAmount(value: unknown, field: string, limit: number): number {
  return value === undefined ? 0 : amount(value, field, limit);
}

function labels(label: string, value: string): Readonly<Record<string, string>> {
  return Object.freeze({ [label]: value });
}

function sample(value: number, sampleLabels: Readonly<Record<string, string>> = EMPTY_LABELS): MetricSample {
  return Object.freeze({ labels: sampleLabels, value });
}

function family(
  name: string,
  type: MetricFamily["type"],
  help: string,
  samples: readonly MetricSample[],
): MetricFamily {
  return Object.freeze({ name, type, help, samples: Object.freeze([...samples]) });
}

function canonicalFamily(index: number, samples: readonly MetricSample[]): MetricFamily {
  const definition = OBSERVABILITY_FAMILY_DEFINITIONS[index];
  if (!definition) throw new Error("invalid_metric_family_definition");
  return family(definition.name, definition.type, definition.help, samples);
}

function recordCount<K extends string>(
  record: Partial<Record<K, number>> | undefined,
  key: K,
  field: string,
  limit: number,
): number {
  return optionalCount(record?.[key], `${field}.${key}`, limit);
}

function timestamp(value: string): string {
  if (typeof value !== "string") invalid("observedAt", "expected_iso_timestamp");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid("observedAt", "expected_iso_timestamp");
  return parsed.toISOString();
}

function normalizeLimits(limits: MetricLimits): Required<MetricLimits> {
  const maxCount = limits.maxCount ?? DEFAULT_METRIC_LIMITS.maxCount;
  const maxAgeSeconds = limits.maxAgeSeconds ?? DEFAULT_METRIC_LIMITS.maxAgeSeconds;
  const maxBytes = limits.maxBytes ?? DEFAULT_METRIC_LIMITS.maxBytes;
  const maxCostUsd = limits.maxCostUsd ?? DEFAULT_METRIC_LIMITS.maxCostUsd;
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) invalid("limits.maxCount", "expected_positive_integer");
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 1) invalid("limits.maxAgeSeconds", "expected_positive_number");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid("limits.maxBytes", "expected_positive_integer");
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 1) invalid("limits.maxCostUsd", "expected_positive_number");
  return { maxCount, maxAgeSeconds, maxBytes, maxCostUsd };
}

/**
 * Convert one already-aggregated database sample into a bounded metric
 * snapshot.  This module deliberately accepts only aggregate values and
 * fixed enum dimensions; tenant, consumer, subscription, event, and error
 * identifiers never enter the snapshot or exporter.
 */
export function collectMetrics(input: DeliveryMetricInput, limits: MetricLimits = {}): MetricSnapshot {
  const bounded = normalizeLimits(limits);
  const observedAt = timestamp(input.observedAt);
  const pendingEvents = count(input.backlog.pendingEvents, "backlog.pendingEvents", bounded.maxCount);
  const oldestPendingAgeSeconds = input.backlog.oldestPendingAgeSeconds === null
    ? 0
    : amount(input.backlog.oldestPendingAgeSeconds, "backlog.oldestPendingAgeSeconds", bounded.maxAgeSeconds);
  const activeLeases = count(input.backlog.activeLeases, "backlog.activeLeases", bounded.maxCount);
  const expiredLeases = count(input.backlog.expiredLeases, "backlog.expiredLeases", bounded.maxCount);

  const attemptsTotal = count(input.attempts.total, "attempts.total", bounded.maxCount);
  const attemptsByOutcome = ATTEMPT_OUTCOMES.map((outcome) => sample(
    recordCount(input.attempts.byOutcome, outcome, "attempts.byOutcome", bounded.maxCount),
    labels("outcome", outcome),
  ));
  const failuresByReason = FAILURE_REASONS.map((reason) => sample(
    recordCount(input.attempts.failuresByReason, reason, "attempts.failuresByReason", bounded.maxCount),
    labels("reason", reason),
  ));
  const failuresTotal = input.attempts.failuresTotal === undefined
    ? Math.min(failuresByReason.reduce((total, current) => total + current.value, 0), bounded.maxCount)
    : count(input.attempts.failuresTotal, "attempts.failuresTotal", bounded.maxCount);
  const retriesTotal = input.attempts.retriesTotal === undefined
    ? recordCount(input.attempts.byOutcome, "retry", "attempts.byOutcome", bounded.maxCount)
    : count(input.attempts.retriesTotal, "attempts.retriesTotal", bounded.maxCount);
  const acknowledgementsTotal = input.attempts.acknowledgementsTotal === undefined
    ? recordCount(input.attempts.byOutcome, "delivered", "attempts.byOutcome", bounded.maxCount)
    : count(input.attempts.acknowledgementsTotal, "attempts.acknowledgementsTotal", bounded.maxCount);
  const deadLettersTotal = input.attempts.deadLettersTotal === undefined
    ? recordCount(input.attempts.byOutcome, "dead_letter", "attempts.byOutcome", bounded.maxCount)
    : count(input.attempts.deadLettersTotal, "attempts.deadLettersTotal", bounded.maxCount);

  const expectedStreams = count(input.liveness.expectedStreams, "liveness.expectedStreams", bounded.maxCount);
  const livenessSamples = LIVENESS_STATES.map((state) => sample(
    recordCount(input.liveness.byState, state, "liveness.byState", bounded.maxCount),
    labels("state", state),
  ));

  const families: MetricFamily[] = [
    canonicalFamily(0, [sample(pendingEvents)]),
    canonicalFamily(1, [sample(oldestPendingAgeSeconds)]),
    canonicalFamily(2, [sample(activeLeases)]),
    canonicalFamily(3, [sample(expiredLeases)]),
    canonicalFamily(4, [
      sample(attemptsTotal, labels("outcome", "all")),
      ...attemptsByOutcome,
    ]),
    canonicalFamily(5, [
      sample(failuresTotal, labels("reason", "all")),
      ...failuresByReason,
    ]),
    canonicalFamily(6, [sample(retriesTotal)]),
    canonicalFamily(7, [sample(acknowledgementsTotal)]),
    canonicalFamily(8, [sample(deadLettersTotal)]),
    canonicalFamily(9, livenessSamples),
    canonicalFamily(10, [sample(expectedStreams)]),
    canonicalFamily(11, [sample(count(input.storage.outboxRows, "storage.outboxRows", bounded.maxCount))]),
    canonicalFamily(12, [sample(count(input.storage.deliveryRows, "storage.deliveryRows", bounded.maxCount))]),
    canonicalFamily(13, [sample(count(input.storage.attemptRows, "storage.attemptRows", bounded.maxCount))]),
    canonicalFamily(14, [sample(amount(input.storage.totalBytes, "storage.totalBytes", bounded.maxBytes))]),
    canonicalFamily(15, [sample(count(input.storage.managedArtifactRows, "storage.managedArtifactRows", bounded.maxCount))]),
    canonicalFamily(16, [sample(amount(input.storage.managedArtifactBytes, "storage.managedArtifactBytes", bounded.maxBytes))]),
    canonicalFamily(17, [sample(optionalAmount(input.cost?.egressBytesTotal, "cost.egressBytesTotal", bounded.maxBytes))]),
    canonicalFamily(18, [sample(optionalAmount(input.cost?.estimatedCostUsdTotal, "cost.estimatedCostUsdTotal", bounded.maxCostUsd))]),
  ];

  return Object.freeze({
    protocolVersion: "0.1" as const,
    observedAt,
    families: Object.freeze(families),
  });
}
