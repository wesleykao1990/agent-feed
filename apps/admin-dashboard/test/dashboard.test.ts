import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectMetrics } from "@agent-feed/operations-observability";
import {
  createAdminDashboardServer,
  containsCredentialQuery,
  JsonFileSnapshotSource,
  isLoopbackAddress,
  metricSnapshotToDashboardSnapshot,
  parseDashboardSnapshot,
  readDashboardState,
  renderDashboardPage,
  StaticSnapshotSource,
} from "../src/index.ts";

const now = Date.parse("2026-08-18T00:10:00.000Z");
const validSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-08-18T00:09:30.000Z",
  freshnessWindowSeconds: 120,
  metrics: {
    pending_events: 4,
    oldest_pending_age_seconds: 12,
    active_leases: 2,
    expired_leases: 0,
    dead_letters_total: 0,
    delivery_attempts_total: 20,
    overdue_streams: 0,
    retention_eligible_artifacts: 3,
  },
};

function get(server: ReturnType<typeof createAdminDashboardServer>, url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_not_listening");
  return new Promise((resolve, reject) => {
    const requestHandle = request({ hostname: "127.0.0.1", port: address.port, path: url, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    requestHandle.on("error", reject);
    requestHandle.end();
  });
}

function emitRequest(
  server: ReturnType<typeof createAdminDashboardServer>,
  requestValue: { method: string; url: string; socket: { remoteAddress?: string } },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    let body = "";
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (value?: string | Buffer) => {
        body = value === undefined ? "" : Buffer.from(value).toString("utf8");
        resolve({ statusCode: response.statusCode, body });
      },
    };
    server.emit("request", requestValue, response);
  });
}

function metricSnapshot() {
  return collectMetrics({
    observedAt: "2026-08-18T00:09:30.000Z",
    backlog: { pendingEvents: 4, oldestPendingAgeSeconds: 12, activeLeases: 2, expiredLeases: 0 },
    attempts: { total: 20, byOutcome: { delivered: 18, retry: 1, failed: 1, dead_letter: 0 } },
    liveness: { expectedStreams: 6, byState: { healthy: 4, due: 0, overdue: 1, degraded: 0, disabled: 1, never_seen: 0 } },
    storage: { outboxRows: 10, deliveryRows: 12, attemptRows: 20, totalBytes: 4096, managedArtifactRows: 3, managedArtifactBytes: 512 },
  });
}

test("snapshot validation accepts the narrow v1 contract and rejects unsafe values", () => {
  const parsed = parseDashboardSnapshot(validSnapshot);
  assert.equal(parsed.generatedAt, "2026-08-18T00:09:30.000Z");
  assert.throws(() => parseDashboardSnapshot({ ...validSnapshot, generatedAt: "2026-08-18T00:09:30+00:00" }), /snapshot_invalid/u);
  assert.throws(() => parseDashboardSnapshot({ ...validSnapshot, generatedAt: "2026-02-30T00:09:30Z" }), /snapshot_invalid/u);
  assert.throws(() => parseDashboardSnapshot({ ...validSnapshot, metrics: { ...validSnapshot.metrics, pending_events: Number.NaN } }), /snapshot_invalid/u);
  assert.throws(() => parseDashboardSnapshot({ ...validSnapshot, freshnessWindowSeconds: 0 }), /snapshot_invalid/u);
});

test("observability mapping accepts only the canonical Agent Feed families and selects state=overdue", () => {
  const mapped = metricSnapshotToDashboardSnapshot(metricSnapshot());
  assert.equal(mapped.metrics.pending_events, 4);
  assert.equal(mapped.metrics.delivery_attempts_total, 20);
  assert.equal(mapped.metrics.overdue_streams, 1);
  assert.equal(mapped.metrics.retention_eligible_artifacts, 3);

  const missing = structuredClone(metricSnapshot()) as unknown as { families: unknown[] };
  missing.families.pop();
  assert.throws(() => metricSnapshotToDashboardSnapshot(missing), /metric_snapshot_invalid/u);

  const duplicate = structuredClone(metricSnapshot()) as unknown as { families: Array<{ name: string }> };
  duplicate.families[1]!.name = duplicate.families[0]!.name;
  assert.throws(() => metricSnapshotToDashboardSnapshot(duplicate), /metric_snapshot_invalid/u);

  const wrongLabel = structuredClone(metricSnapshot()) as unknown as { families: Array<{ name: string; samples: Array<{ labels: Record<string, string> }> }> };
  const liveness = wrongLabel.families.find((family) => family.name === "agent_feed_liveness_streams")!;
  liveness.samples[2]!.labels = { state: "overdue", tenant_id: "secret" };
  assert.throws(() => metricSnapshotToDashboardSnapshot(wrongLabel), /metric_snapshot_invalid/u);

  const outOfBounds = structuredClone(metricSnapshot()) as unknown as { families: Array<{ name: string; samples: Array<{ value: number }> }> };
  outOfBounds.families[0]!.samples[0]!.value = 1_000_000_000_001;
  assert.throws(() => metricSnapshotToDashboardSnapshot(outOfBounds), /metric_snapshot_invalid/u);
});

test("state distinguishes empty, fresh, and stale snapshots without leaking source errors", async () => {
  const empty = await readDashboardState(new StaticSnapshotSource(null), () => now);
  assert.deepEqual(empty, { kind: "empty", reason: "no_snapshot" });
  const fresh = await readDashboardState(new StaticSnapshotSource(validSnapshot), () => now);
  assert.equal(fresh.kind, "ready");
  if (fresh.kind === "ready") assert.equal(fresh.stale, false);
  const stale = await readDashboardState(new StaticSnapshotSource(validSnapshot), () => now + 200_000);
  assert.equal(stale.kind, "ready");
  if (stale.kind === "ready") assert.equal(stale.stale, true);
  const invalid = await readDashboardState(new StaticSnapshotSource({ schemaVersion: 1 }), () => now);
  assert.deepEqual(invalid, { kind: "error", error: "snapshot_invalid" });
  const future = await readDashboardState(new StaticSnapshotSource({ ...validSnapshot, generatedAt: "2026-08-18T01:00:00Z" }), () => now);
  assert.deepEqual(future, { kind: "error", error: "snapshot_invalid" });
});

test("HTML escapes dynamic values and contains no executable or source-derived markup", () => {
  const page = renderDashboardPage({ kind: "ready", snapshot: parseDashboardSnapshot(validSnapshot), stale: false, ageSeconds: 30 });
  assert.match(page, /Content-Security-Policy/u);
  assert.doesNotMatch(page, /<script/iu);
  assert.doesNotMatch(page, /javascript:/iu);
  assert.match(page, /aria-label=/u);
  assert.match(page, /Snapshot API/u);
});

test("HTTP server exposes read-only HTML and sanitized API states", async () => {
  const server = createAdminDashboardServer({ source: new StaticSnapshotSource(validSnapshot), now: () => now });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await get(server, "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/u);
    assert.match(page.body, /Needs attention/u);
    const api = await get(server, "/api/snapshot");
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).snapshot.metrics.pending_events, 4);
    const method = await new Promise<number>((resolve, reject) => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server_not_listening"));
      const handle = request({ hostname: "127.0.0.1", port: address.port, path: "/", method: "POST" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      handle.on("error", reject);
      handle.end();
    });
    assert.equal(method, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("dashboard denies remote clients by default and allows only an injected guard", async () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("203.0.113.7"), false);
  assert.equal(containsCredentialQuery("/?token=secret"), true);
  assert.equal(containsCredentialQuery("/"), false);

  const deniedServer = createAdminDashboardServer({ source: new StaticSnapshotSource(validSnapshot) });
  const denied = await emitRequest(deniedServer, { method: "GET", url: "/", socket: { remoteAddress: "203.0.113.7" } });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.body, "");

  let authorizeCalls = 0;
  const authorizedServer = createAdminDashboardServer({
    source: new StaticSnapshotSource(validSnapshot),
    authorize: () => {
      authorizeCalls += 1;
      return true;
    },
  });
  const authorized = await emitRequest(authorizedServer, { method: "GET", url: "/", socket: { remoteAddress: "203.0.113.7" } });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorizeCalls, 1);
  const credentialUrl = await emitRequest(authorizedServer, { method: "GET", url: "/?access_token=secret", socket: { remoteAddress: "203.0.113.7" } });
  assert.equal(credentialUrl.statusCode, 404);
  assert.equal(authorizeCalls, 1);
});

test("file adapter bounds snapshot input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-feed-dashboard-"));
  try {
    const file = path.join(root, "snapshot.json");
    await writeFile(file, JSON.stringify(validSnapshot), { mode: 0o600 });
    const state = await readDashboardState(new JsonFileSnapshotSource(file), () => now);
    assert.equal(state.kind, "ready");
    const oversized = path.join(root, "oversized.json");
    await writeFile(oversized, Buffer.alloc(1_048_577, 120), { mode: 0o600 });
    assert.deepEqual(
      await readDashboardState(new JsonFileSnapshotSource(oversized), () => now),
      { kind: "error", error: "snapshot_invalid" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
