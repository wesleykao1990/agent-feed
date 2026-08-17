import type { MetricsSink } from "./types.ts";

export interface MetricsSnapshot {
  counters: Readonly<Record<string, number>>;
  observations: Readonly<Record<string, readonly number[]>>;
  seriesCount: number;
}

export interface InMemoryMetricsOptions {
  maxSeries?: number;
  /** Maximum retained samples per observation series. New samples replace the oldest. */
  maxObservationSamplesPerSeries?: number;
  allowedLabelKeys?: readonly string[];
  allowedLabelValues?: Readonly<Record<string, readonly string[]>>;
  allowedMetricNames?: readonly string[];
}

function normalizeLabels(
  labels: Readonly<Record<string, string>> | undefined,
  options: InMemoryMetricsOptions,
): Readonly<Record<string, string>> {
  if (!labels) return {};
  const allowedKeys = new Set(options.allowedLabelKeys ?? []);
  const output: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    if (allowedKeys.size > 0 && !allowedKeys.has(key)) continue;
    const value = labels[key];
    if (value === undefined) continue;
    const allowedValues = options.allowedLabelValues?.[key];
    output[key] = allowedValues && !allowedValues.includes(value) ? "other" : value;
  }
  return output;
}

function seriesKey(name: string, labels: Readonly<Record<string, string>>): string {
  return `${name}|${JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))}`;
}

/**
 * Small bounded sink intended for deterministic tests and local diagnostics.
 * Unknown metric names/labels are collapsed instead of creating unbounded
 * series. Production adapters can implement the same MetricsSink contract.
 */
export class InMemoryMetricsSink implements MetricsSink {
  readonly #options: InMemoryMetricsOptions;
  readonly #counters = new Map<string, number>();
  readonly #observations = new Map<string, number[]>();
  readonly #series = new Set<string>();

  constructor(options: InMemoryMetricsOptions = {}) {
    this.#options = {
      maxSeries: options.maxSeries ?? 100,
      maxObservationSamplesPerSeries: options.maxObservationSamplesPerSeries ?? 1_000,
      ...(options.allowedLabelKeys === undefined ? {} : { allowedLabelKeys: [...options.allowedLabelKeys] }),
      ...(options.allowedLabelValues === undefined ? {} : { allowedLabelValues: options.allowedLabelValues }),
      ...(options.allowedMetricNames === undefined ? {} : { allowedMetricNames: [...options.allowedMetricNames] }),
    };
    const maxSeries = this.#options.maxSeries;
    if (maxSeries === undefined || !Number.isSafeInteger(maxSeries) || maxSeries < 1) throw new Error("invalid_metric_series_limit");
    const maxObservationSamplesPerSeries = this.#options.maxObservationSamplesPerSeries;
    if (
      maxObservationSamplesPerSeries === undefined
      || !Number.isSafeInteger(maxObservationSamplesPerSeries)
      || maxObservationSamplesPerSeries < 1
    ) throw new Error("invalid_metric_observation_limit");
  }

  increment(name: string, value = 1, labels?: Readonly<Record<string, string>>): void {
    if (!Number.isFinite(value)) throw new Error("invalid_metric_value");
    const key = this.#key(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void {
    if (!Number.isFinite(value)) throw new Error("invalid_metric_value");
    const key = this.#key(name, labels);
    const values = this.#observations.get(key) ?? [];
    const maxSamples = this.#options.maxObservationSamplesPerSeries ?? 1_000;
    if (values.length >= maxSamples) values.shift();
    values.push(value);
    this.#observations.set(key, values);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.#counters),
      observations: Object.fromEntries([...this.#observations].map(([key, values]) => [key, [...values]])),
      seriesCount: this.#series.size,
    };
  }

  getCounter(name: string, labels?: Readonly<Record<string, string>>): number {
    return this.#counters.get(this.#key(name, labels)) ?? 0;
  }

  getObservations(name: string, labels?: Readonly<Record<string, string>>): readonly number[] {
    return [...(this.#observations.get(this.#key(name, labels)) ?? [])];
  }

  #key(name: string, labels?: Readonly<Record<string, string>>): string {
    const allowedNames = this.#options.allowedMetricNames;
    const metricName = allowedNames && !allowedNames.includes(name) ? "unknown" : name;
    const normalized = normalizeLabels(labels, this.#options);
    const requested = seriesKey(metricName, normalized);
    if (this.#series.has(requested)) return requested;
    const maxSeries = this.#options.maxSeries ?? 100;
    if (maxSeries > 1 && this.#series.size < maxSeries - 1) {
      this.#series.add(requested);
      return requested;
    }
    const overflow = seriesKey("overflow", {});
    this.#series.add(overflow);
    return overflow;
  }
}

export class NoopMetricsSink implements MetricsSink {
  increment(_name: string, _value?: number, _labels?: Readonly<Record<string, string>>): void {}
  observe(_name: string, _value: number, _labels?: Readonly<Record<string, string>>): void {}
}
