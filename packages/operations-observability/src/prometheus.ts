import { OBSERVABILITY_FAMILY_DEFINITIONS } from "./collect.ts";
import { ATTEMPT_OUTCOMES, FAILURE_REASONS, LIVENESS_STATES } from "./types.ts";
import type { MetricFamily, MetricSample, MetricSnapshot, PrometheusOptions } from "./types.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const EMPTY_LABELS: Readonly<Record<string, string>> = Object.freeze({});

function invalid(path: string, reason: string): never {
  throw new Error(`invalid_metric_snapshot:${path}:${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "expected_string");
  if (CONTROL_CHARACTERS.test(value)) invalid(path, "control_character");
  return value;
}

function exactString(value: unknown, expected: string, path: string): void {
  if (safeString(value, path) !== expected) invalid(path, "unexpected_value");
}

function expectedLabels(index: number): readonly Readonly<Record<string, string>>[] {
  if (index === 4) {
    return ["all", ...ATTEMPT_OUTCOMES].map((outcome) => Object.freeze({ outcome }));
  }
  if (index === 5) {
    return ["all", ...FAILURE_REASONS].map((reason) => Object.freeze({ reason }));
  }
  if (index === 9) {
    return LIVENESS_STATES.map((state) => Object.freeze({ state }));
  }
  return [EMPTY_LABELS];
}

function validateLabels(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  path: string,
): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) invalid(path, "expected_record");
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (keys.length !== expectedKeys.length) invalid(path, "unexpected_label_count");
  for (let index = 0; index < keys.length; index += 1) {
    const key = safeString(keys[index], `${path}.key[${index}]`);
    const expectedKey = expectedKeys[index];
    if (expectedKey === undefined || key !== expectedKey) invalid(path, "unexpected_label_key");
    const expectedValue = expected[expectedKey];
    if (expectedValue === undefined) invalid(path, "missing_label_policy");
    exactString(value[key], expectedValue, `${path}.${expectedKey}`);
  }
}

function validateSample(value: unknown, expected: Readonly<Record<string, string>>, path: string): asserts value is MetricSample {
  if (!isRecord(value)) invalid(path, "expected_record");
  if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) {
    invalid(`${path}.value`, "expected_finite_non_negative_number");
  }
  validateLabels(value.labels, expected, `${path}.labels`);
}

function validateObservedAt(value: unknown): string {
  const observedAt = safeString(value, "observedAt");
  const parsed = new Date(observedAt);
  const milliseconds = parsed.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) invalid("observedAt", "expected_safe_iso_timestamp");
  if (parsed.toISOString() !== observedAt) invalid("observedAt", "expected_canonical_iso_timestamp");
  return observedAt;
}

function validateSnapshot(value: unknown): asserts value is MetricSnapshot {
  if (!isRecord(value)) invalid("snapshot", "expected_record");
  exactString(value.protocolVersion, "0.1", "protocolVersion");
  validateObservedAt(value.observedAt);
  if (!Array.isArray(value.families)) invalid("families", "expected_array");
  if (value.families.length !== OBSERVABILITY_FAMILY_DEFINITIONS.length) {
    invalid("families", "unexpected_family_count");
  }

  for (let index = 0; index < OBSERVABILITY_FAMILY_DEFINITIONS.length; index += 1) {
    const definition = OBSERVABILITY_FAMILY_DEFINITIONS[index];
    const family = value.families[index];
    if (!definition || !isRecord(family)) invalid(`families[${index}]`, "expected_canonical_family");
    exactString(family.name, definition.name, `families[${index}].name`);
    exactString(family.type, definition.type, `families[${index}].type`);
    exactString(family.help, definition.help, `families[${index}].help`);
    if (!Array.isArray(family.samples)) invalid(`families[${index}].samples`, "expected_array");
    const labels = expectedLabels(index);
    if (family.samples.length !== labels.length) invalid(`families[${index}].samples`, "unexpected_sample_count");
    for (let sampleIndex = 0; sampleIndex < labels.length; sampleIndex += 1) {
      const expected = labels[sampleIndex];
      if (!expected) invalid(`families[${index}].samples[${sampleIndex}]`, "missing_label_policy");
      validateSample(family.samples[sampleIndex], expected, `families[${index}].samples[${sampleIndex}]`);
    }
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function formatSample(name: string, sample: MetricSample, timestampMs: number | undefined): string {
  const timestamp = timestampMs === undefined ? "" : ` ${timestampMs}`;
  return `${name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}${timestamp}`;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_prometheus_timestamp");
  return value;
}

/**
 * Render the allowlisted snapshot in Prometheus text exposition format.
 * Families and their fixed labels are already normalized by collectMetrics;
 * this renderer never accepts caller-supplied label maps.
 */
export function toPrometheus(snapshot: MetricSnapshot, options: PrometheusOptions = {}): string {
  validateSnapshot(snapshot);
  const timestampMs = options.includeTimestamp === true
    ? validTimestamp(options.timestampMs ?? new Date(snapshot.observedAt).getTime())
    : undefined;
  const lines: string[] = [];
  for (const family of snapshot.families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) lines.push(formatSample(family.name, sample, timestampMs));
  }
  return `${lines.join("\n")}\n`;
}

export function findMetricFamily(snapshot: MetricSnapshot, name: string): MetricFamily | undefined {
  return snapshot.families.find((family) => family.name === name);
}
