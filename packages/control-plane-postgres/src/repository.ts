import { Pool } from "pg";
import {
  normalizeControlPlaneSnapshot,
  type AssessmentState,
  type ControlPlaneSnapshot,
  type CountGroup,
  type DeliveryState,
  type FailureAggregate,
  type FailureLayer,
  type JobState,
  type OccurrenceState,
  type RunState,
} from "@agent-feed/control-plane-core";
import { CONTROL_PLANE_QUERIES } from "./queries.ts";
import { ControlPlanePostgresError, type ControlPlaneQueryOptions, type SqlClient, type SqlPool } from "./types.ts";

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DEFAULT_OBSERVATION_WINDOW_SECONDS = 86_400;
const DEFAULT_FRESHNESS_WINDOW_SECONDS = 60;
const MAX_OBSERVATION_WINDOW_SECONDS = 2_592_000;

const JOB_STATES = ["draft", "shadow", "active", "paused", "retired"] as const;
const OCCURRENCE_STATES = ["pending", "absent", "running", "completed_zero", "completed", "partial", "failed", "cancelled"] as const;
const RUN_STATES = ["running", "completed", "partial", "failed", "cancelled"] as const;
const ASSESSMENT_STATES = ["passed", "failed", "inconclusive", "unknown"] as const;
const DELIVERY_STATES = ["queued", "leased", "retry", "acknowledged", "dead_letter"] as const;
const FAILURE_LAYERS = ["provider", "gateway", "execution", "validation", "delivery"] as const;

interface CountRow {
  state: string;
  count: string | number;
}

interface TimeRow {
  generated_at: Date | string;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ControlPlanePostgresError("invalid_input", `${field} must be a safe integer between ${min} and ${max}`);
  }
  return value as number;
}

function utc(value: unknown, field: string): string {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ControlPlanePostgresError("invalid_input", `${field} must be a strict UTC timestamp`);
  }
  return new Date(value).toISOString();
}

function dbUtc(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new ControlPlanePostgresError("storage_error", "database returned an invalid clock value");
  return date.toISOString();
}

function count(value: string | number, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new ControlPlanePostgresError("storage_error", `database returned an invalid ${field}`);
  return result;
}

function countGroup<T extends string>(rows: readonly CountRow[], states: readonly T[], label: string): CountGroup<T> {
  const byState = Object.fromEntries(states.map((state) => [state, 0])) as Record<T, number>;
  const seen = new Set<T>();
  for (const row of rows) {
    if (!(states as readonly string[]).includes(row.state)) throw new ControlPlanePostgresError("storage_error", `database returned an unknown ${label} state`);
    const state = row.state as T;
    if (seen.has(state)) throw new ControlPlanePostgresError("storage_error", `database returned duplicate ${label} state`);
    seen.add(state);
    byState[state] = count(row.count, `${label} count`);
  }
  return { total: Object.values(byState as Record<string, number>).reduce((sum, item) => sum + item, 0), byState };
}

async function rows(client: SqlClient, sql: string, values: unknown[]): Promise<CountRow[]> {
  const result = await client.query<CountRow>(sql, values);
  return result.rows;
}

function failures(rowsToMap: readonly CountRow[]): FailureAggregate[] {
  const group = countGroup<FailureLayer>(rowsToMap, FAILURE_LAYERS, "failure layer");
  return FAILURE_LAYERS.map((layer) => ({ layer, count: group.byState[layer] }));
}

export function createControlPlanePool(connectionString: string): SqlPool {
  return new Pool({ connectionString });
}

export class PostgresControlPlaneRepository {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async getSnapshot(options: ControlPlaneQueryOptions): Promise<ControlPlaneSnapshot> {
    if (!options || typeof options !== "object" || !TENANT.test(options.tenantId)) {
      throw new ControlPlanePostgresError("invalid_input", "tenantId is invalid");
    }
    const observationWindowSeconds = boundedInteger(options.observationWindowSeconds ?? DEFAULT_OBSERVATION_WINDOW_SECONDS, "observationWindowSeconds", 60, MAX_OBSERVATION_WINDOW_SECONDS);
    const freshnessWindowSeconds = boundedInteger(options.freshnessWindowSeconds ?? DEFAULT_FRESHNESS_WINDOW_SECONDS, "freshnessWindowSeconds", 1, 86_400);
    const suppliedAsOf = options.asOf === undefined ? null : utc(options.asOf, "asOf");
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const clock = await client.query<TimeRow>("/* m10:clock */ select coalesce($1::timestamptz, transaction_timestamp()) as generated_at", [suppliedAsOf]);
      const generatedAt = dbUtc(clock.rows[0]?.generated_at);
      const from = new Date(Date.parse(generatedAt) - observationWindowSeconds * 1000).toISOString();
      const values = [options.tenantId, from, generatedAt];
      const jobs = countGroup<JobState>(await rows(client, CONTROL_PLANE_QUERIES.jobs, [options.tenantId]), JOB_STATES, "job");
      const occurrences = countGroup<OccurrenceState>(await rows(client, CONTROL_PLANE_QUERIES.occurrences, values), OCCURRENCE_STATES, "occurrence");
      const runs = countGroup<RunState>(await rows(client, CONTROL_PLANE_QUERIES.runs, values), RUN_STATES, "run");
      const assessments = countGroup<AssessmentState>(await rows(client, CONTROL_PLANE_QUERIES.assessments, values), ASSESSMENT_STATES, "assessment");
      const deliveries = countGroup<DeliveryState>(await rows(client, CONTROL_PLANE_QUERIES.deliveries, values), DELIVERY_STATES, "delivery");
      const failureRows = await rows(client, CONTROL_PLANE_QUERIES.failures, values);
      const snapshot = normalizeControlPlaneSnapshot({
        tenantId: options.tenantId,
        generatedAt,
        freshnessWindowSeconds,
        observationWindow: { from, to: generatedAt },
        jobs,
        occurrences,
        runs,
        assessments,
        deliveries,
        failures: failures(failureRows),
      });
      await client.query("commit");
      return snapshot;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve the primary failure */ }
      if (error instanceof ControlPlanePostgresError) throw error;
      throw new ControlPlanePostgresError("storage_error", "control-plane snapshot query failed", error);
    } finally {
      client.release();
    }
  }
}
