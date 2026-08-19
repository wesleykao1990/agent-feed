import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkM5OperationsArchitecture, checkM5OperationsTexts } from "../../scripts/check_m5_operations_architecture.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function currentTexts() {
  const read = (relative) => readFile(path.join(ROOT, relative), "utf8");
  return {
    sqliteSchema: await read("examples/sqlite/schema.sql"),
    operationsCore: `${await read("packages/operations-core/src/types.ts")}\n${await read("packages/operations-core/src/retention.ts")}`,
    operationsMigration: await read("packages/operations-postgres/migrations/0004_operations.sql"),
    observability: `${await read("packages/operations-observability/src/collect.ts")}\n${await read("packages/operations-observability/src/prometheus.ts")}`,
    dashboardServer: await read("apps/admin-dashboard/src/server.ts"),
    dashboardAdapter: await read("apps/admin-dashboard/src/observability.ts"),
    supabaseEdge: await read("examples/supabase/functions/producer-ingress/index.ts"),
    rootPackage: await read("package.json"),
    runner: await read("scripts/run_m5_conformance.mjs"),
    workflow: await read(".github/workflows/ci.yml"),
  };
}

test("the integrated M5 portability and operations architecture passes", () => {
  assert.equal(checkM5OperationsArchitecture(ROOT), 7);
});

test("the guard rejects deletion of immutable source and delivery history", async () => {
  const fixture = await currentTexts();
  fixture.operationsMigration += "\ndelete from agent_feed.findings;\n";
  assert.equal(checkM5OperationsTexts(fixture).some((failure) => failure.includes("immutable protocol")), true);
});

test("the guard rejects false tenant isolation over globally keyed liveness tables", async () => {
  const fixture = await currentTexts();
  fixture.operationsMigration += "\nalter table agent_feed.stream_expectations add column tenant_id text;\n";
  assert.equal(checkM5OperationsTexts(fixture).some((failure) => failure.includes("globally keyed liveness")), true);
});

test("the guard requires bounded Supabase responses and fail-closed dashboard access", async () => {
  const fixture = await currentTexts();
  fixture.supabaseEdge = fixture.supabaseEdge.replaceAll("MAX_RESPONSE_BODY_BYTES", "UNBOUNDED_RESPONSE");
  fixture.dashboardServer = "export function createAdminDashboardServer() {}\n";
  const failures = checkM5OperationsTexts(fixture);
  assert.equal(failures.some((failure) => failure.includes("MAX_RESPONSE_BODY_BYTES")), true);
  assert.equal(failures.some((failure) => failure.includes("isLoopbackAddress")), true);
});

test("the guard requires the live, non-skipping combined gate in CI", async () => {
  const fixture = await currentTexts();
  fixture.workflow = fixture.workflow.replaceAll("npm run m5:conformance", "npm run m5a:conformance");
  assert.equal(checkM5OperationsTexts(fixture).some((failure) => failure.includes("npm run m5:conformance")), true);
});
