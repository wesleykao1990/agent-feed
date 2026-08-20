import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_PLANE_QUERIES, ControlPlanePostgresError, PostgresControlPlaneRepository, type SqlPool } from "../src/index.ts";

function result(rows: unknown[]) {
  return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
}

function fakePool(overrides: Partial<Record<keyof typeof CONTROL_PLANE_QUERIES, unknown[]>> = {}) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (sql.includes("m10:clock")) return result([{ generated_at: "2026-08-20T12:00:00.000Z" }]);
      if (sql.includes("m10:jobs")) return result(overrides.jobs ?? [{ state: "active", count: "1" }]);
      if (sql.includes("m10:occurrences")) return result(overrides.occurrences ?? [{ state: "completed_zero", count: "1" }, { state: "absent", count: "1" }]);
      if (sql.includes("m10:runs")) return result(overrides.runs ?? [{ state: "completed", count: "1" }]);
      if (sql.includes("m10:assessments")) return result(overrides.assessments ?? [{ state: "passed", count: "1" }]);
      if (sql.includes("m10:deliveries")) return result(overrides.deliveries ?? [{ state: "retry", count: "1" }]);
      if (sql.includes("m10:failures")) return result(overrides.failures ?? [
        { state: "provider", count: "0" }, { state: "gateway", count: "0" },
        { state: "execution", count: "0" }, { state: "validation", count: "0" },
        { state: "delivery", count: "1" },
      ]);
      return result([]);
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query, end: async () => {} } as unknown as SqlPool;
  return { pool, calls };
}

test("builds a bounded payload-free snapshot in one read-only repeatable-read transaction", async () => {
  const { pool, calls } = fakePool();
  const repository = new PostgresControlPlaneRepository(pool);
  const snapshot = await repository.getSnapshot({
    tenantId: "tenant-a", asOf: "2026-08-20T12:00:00.000Z",
    observationWindowSeconds: 3_600, freshnessWindowSeconds: 30,
  });
  assert.equal(snapshot.tenantId, "tenant-a");
  assert.deepEqual(snapshot.observationWindow, { from: "2026-08-20T11:00:00.000Z", to: "2026-08-20T12:00:00.000Z" });
  assert.equal(snapshot.occurrences.byState.completed_zero, 1);
  assert.equal(snapshot.occurrences.byState.absent, 1);
  assert.equal(snapshot.failures.delivery, 1);
  assert.equal(snapshot.health, "critical");
  assert.match(calls[0]!.sql, /repeatable read read only/iu);
  assert.equal(calls.at(-1)?.sql, "commit");
  for (const call of calls.filter((item) => item.sql.includes("m10:") && !item.sql.includes("clock"))) {
    assert.equal(call.values?.[0], "tenant-a");
  }
});

test("rejects unknown database states and rolls back without returning a partial snapshot", async () => {
  const { pool, calls } = fakePool({ runs: [{ state: "mystery", count: "1" }] });
  const repository = new PostgresControlPlaneRepository(pool);
  await assert.rejects(repository.getSnapshot({ tenantId: "tenant-a", asOf: "2026-08-20T12:00:00.000Z" }),
    (error: unknown) => error instanceof ControlPlanePostgresError && error.code === "storage_error");
  assert.equal(calls.at(-1)?.sql, "rollback");
});

test("validates tenant, window, freshness, and deterministic clock inputs before opening a transaction", async () => {
  const { pool, calls } = fakePool();
  const repository = new PostgresControlPlaneRepository(pool);
  await assert.rejects(repository.getSnapshot({ tenantId: "tenant with spaces" }), /tenantId is invalid/u);
  await assert.rejects(repository.getSnapshot({ tenantId: "tenant-a", observationWindowSeconds: 1 }), /observationWindowSeconds/u);
  await assert.rejects(repository.getSnapshot({ tenantId: "tenant-a", freshnessWindowSeconds: 0 }), /freshnessWindowSeconds/u);
  await assert.rejects(repository.getSnapshot({ tenantId: "tenant-a", asOf: "2026-08-20" }), /strict UTC/u);
  assert.equal(calls.length, 0);
});

test("query inventory selects only aggregate state and count data", () => {
  const sql = Object.values(CONTROL_PLANE_QUERIES).join("\n").toLowerCase();
  for (const forbidden of ["envelope", "payload", "metadata", "summary", "error_detail", "signature", "storage_ref", "instruction_reference", "off_switch_reference"]) {
    assert.equal(sql.includes(forbidden), false, forbidden);
  }
  for (const marker of ["tenant_id = $1", "count(*)::text", "assessment_receipt_seals", "completed_zero", "dead_letter"]) assert.equal(sql.includes(marker), true, marker);
});
