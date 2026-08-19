import { readFile, stat } from "node:fs/promises";
import type {
  DashboardClock,
  DashboardMetricKey,
  DashboardMetricValues,
  DashboardSnapshot,
  DashboardSnapshotSource,
  DashboardSnapshotState,
} from "./contracts.ts";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.ts";

const METRIC_KEYS: readonly DashboardMetricKey[] = [
  "pending_events",
  "oldest_pending_age_seconds",
  "active_leases",
  "expired_leases",
  "dead_letters_total",
  "delivery_attempts_total",
  "overdue_streams",
  "retention_eligible_artifacts",
];

const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_METRIC_VALUE = 1_000_000_000_000;
const MAX_FRESHNESS_SECONDS = 86_400;
const MAX_CLOCK_SKEW_SECONDS = 60;

export class DashboardSnapshotError extends Error {
  readonly code = "snapshot_invalid" as const;

  constructor() {
    super("snapshot_invalid");
    this.name = "DashboardSnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteNumber(value: unknown, { allowFraction = true }: { allowFraction?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_METRIC_VALUE) {
    throw new DashboardSnapshotError();
  }
  if (!allowFraction && !Number.isSafeInteger(value)) throw new DashboardSnapshotError();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) throw new DashboardSnapshotError();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
  if (!match) throw new DashboardSnapshotError();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new DashboardSnapshotError();
  // Date.parse normalizes impossible calendar dates (for example February 30);
  // compare the non-fractional portion to keep the wire contract strict.
  if (parsed.toISOString().slice(0, 19) !== match[1]) throw new DashboardSnapshotError();
  return parsed.toISOString();
}

function metricValues(value: unknown): DashboardMetricValues {
  if (!isRecord(value)) throw new DashboardSnapshotError();
  const result = {} as Record<DashboardMetricKey, number>;
  for (const key of METRIC_KEYS) {
    result[key] = finiteNumber(value[key]);
  }
  return result;
}

/** Validate and normalize the adapter boundary into a stable v1 snapshot. */
export function parseDashboardSnapshot(value: unknown): DashboardSnapshot {
  if (!isRecord(value)) throw new DashboardSnapshotError();
  if (value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) throw new DashboardSnapshotError();
  if (typeof value.freshnessWindowSeconds !== "number" || !Number.isSafeInteger(value.freshnessWindowSeconds)) {
    throw new DashboardSnapshotError();
  }
  if (value.freshnessWindowSeconds < 1 || value.freshnessWindowSeconds > MAX_FRESHNESS_SECONDS) {
    throw new DashboardSnapshotError();
  }
  return Object.freeze({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: timestamp(value.generatedAt),
    freshnessWindowSeconds: value.freshnessWindowSeconds,
    metrics: Object.freeze(metricValues(value.metrics)),
  });
}

export class JsonFileSnapshotSource implements DashboardSnapshotSource {
  readonly #path: string;

  constructor(filePath: string) {
    if (!filePath || filePath.includes("\0")) throw new TypeError("snapshot_path_invalid");
    this.#path = filePath;
  }

  async read(): Promise<unknown> {
    const fileInfo = await stat(this.#path);
    if (!fileInfo.isFile() || fileInfo.size > MAX_SNAPSHOT_BYTES) throw new DashboardSnapshotError();
    const contents = await readFile(this.#path, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_SNAPSHOT_BYTES) throw new DashboardSnapshotError();
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new DashboardSnapshotError();
    }
  }
}

export class StaticSnapshotSource implements DashboardSnapshotSource {
  readonly #value: unknown;

  constructor(value: unknown) {
    this.#value = structuredClone(value);
  }

  async read(): Promise<unknown> {
    return structuredClone(this.#value);
  }
}

export async function readDashboardState(
  source: DashboardSnapshotSource,
  now: DashboardClock = () => Date.now(),
): Promise<DashboardSnapshotState> {
  let raw: unknown;
  try {
    raw = await source.read();
  } catch (error) {
    if (error instanceof DashboardSnapshotError) return { kind: "error", error: "snapshot_invalid" };
    return { kind: "error", error: "snapshot_unavailable" };
  }
  if (raw === null || raw === undefined) return { kind: "empty", reason: "no_snapshot" };
  let snapshot: DashboardSnapshot;
  try {
    snapshot = parseDashboardSnapshot(raw);
  } catch {
    return { kind: "error", error: "snapshot_invalid" };
  }
  const currentTime = now();
  const generatedTime = Date.parse(snapshot.generatedAt);
  if (generatedTime - currentTime > MAX_CLOCK_SKEW_SECONDS * 1_000) {
    return { kind: "error", error: "snapshot_invalid" };
  }
  const ageSeconds = Math.max(0, (currentTime - generatedTime) / 1_000);
  return {
    kind: "ready",
    snapshot,
    ageSeconds,
    stale: ageSeconds > snapshot.freshnessWindowSeconds,
  };
}

export { MAX_CLOCK_SKEW_SECONDS, MAX_SNAPSHOT_BYTES, METRIC_KEYS };
