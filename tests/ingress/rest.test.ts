import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import {
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../../packages/persistence-postgres/src/index.ts";
import {
  batchPayload,
  beginPayload,
  completePayload,
  completeZeroPayload,
  credentialA,
  credentialB,
  evidencePayload,
  findingPayload,
  PRODUCER_B,
  STREAM_B,
  TEST_SECRET_A,
  TEST_SECRET_B,
  fixtureId,
} from "./fixtures.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
type PgPool = ReturnType<typeof createAgentFeedPool>;
const API_ENTRY_POINT = "../../apps/api/src/index.ts";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface HttpResult {
  response: Response;
  body: Json;
  raw: string;
}

interface ApiServerOptions {
  persistence: PostgresAgentFeedPersistence;
  service: PostgresAgentFeedPersistence;
  store: PostgresAgentFeedPersistence;
  credentials: readonly Record<string, unknown>[];
  producerCredentials: readonly Record<string, unknown>[];
  token: string;
  databaseUrl: string;
  rate_limit: {
    max_requests_per_minute: number;
    burst: number;
  };
}

interface PublicApiModule {
  createAgentFeedApiServer?: (options: ApiServerOptions) => Server | { server: Server } | Promise<Server | { server: Server }>;
}

interface StartedServer {
  baseUrl: string;
  server: Server;
}

interface StartedProcess {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
}

function rejectAfter(milliseconds: number, message: () => string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), milliseconds);
    timer.unref();
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    rejectAfter(5_000, () => "API process did not stop after SIGTERM"),
  ]);
}

async function startApiProcess(context: TestContext): Promise<StartedProcess> {
  const port = await reserveLoopbackPort();
  const entrypoint = fileURLToPath(new URL("../../apps/api/src/main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      AGENT_FEED_DATABASE_URL: databaseUrl!,
      AGENT_FEED_PRODUCER_CREDENTIALS: JSON.stringify([credentialA(), credentialB()]),
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (stdout.includes("Agent Feed API:")) resolve();
      };
      child.stdout.on("data", inspect);
      child.once("exit", (code, signal) => reject(new Error(`API process exited before readiness (${String(code ?? signal)}): ${stderr}`)));
      inspect();
    }),
    rejectAfter(10_000, () => `API process startup timed out: ${stderr}`),
  ]);
  context.after(async () => stopProcess(child));
  return { baseUrl: `http://127.0.0.1:${port}`, child };
}

function record(value: Json): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as Record<string, unknown>;
}

function bodyRun(value: Json): Record<string, unknown> {
  const root = record(value);
  if (typeof root.run_id === "string") return root;
  for (const key of ["run", "result", "data"]) {
    const nested = root[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const candidate = nested as Record<string, unknown>;
      if (typeof candidate.run_id === "string") return candidate;
    }
  }
  throw new Error("response did not contain a run_id");
}

function bodyFindings(value: Json): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  if (Array.isArray(root.findings)) return root.findings;
  for (const key of ["result", "data"]) {
    const nested = root[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const findings = (nested as Record<string, unknown>).findings;
      if (Array.isArray(findings)) return findings;
    }
  }
  throw new Error("response did not contain findings");
}

function auth(secret: string): Record<string, string> {
  return {
    authorization: `Bearer ${secret}`,
  };
}

async function jsonRequest(
  baseUrl: string,
  pathname: string,
  options: RequestInit = {},
): Promise<HttpResult> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const raw = await response.text();
  let body: Json = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as Json;
    } catch {
      body = raw;
    }
  }
  return { response, body, raw };
}

async function startApi(
  context: TestContext,
  persistence: PostgresAgentFeedPersistence,
  rateLimit = { max_requests_per_minute: 1_000, burst: 1_000 },
): Promise<StartedServer> {
  // This is the application package's public entry point.  The test does not
  // import producer-service, SQL helpers, or the prototype server.
  const api = await import(API_ENTRY_POINT) as unknown as PublicApiModule;
  if (typeof api.createAgentFeedApiServer !== "function") {
    throw new Error("apps/api public entry point must export createAgentFeedApiServer");
  }
  const options: ApiServerOptions = {
    persistence,
    service: persistence,
    store: persistence,
    credentials: [credentialA(), credentialB()],
    producerCredentials: [credentialA(), credentialB()],
    token: TEST_SECRET_A,
    databaseUrl: databaseUrl!,
    // Lifecycle conformance deliberately performs more than ten requests in a
    // burst. Rate-limit behavior has a focused test; it must not mask storage
    // and idempotency assertions here.
    rate_limit: rateLimit,
  };
  const created = await api.createAgentFeedApiServer(options);
  const server = "server" in created ? created.server : created;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl, server };
}

async function setup(context: TestContext): Promise<{ pool: PgPool; persistence: PostgresAgentFeedPersistence; baseUrl: string; server: Server }> {
  const pool = createAgentFeedPool(databaseUrl);
  context.after(async () => pool.end());
  await migrateAgentFeed(pool);
  const persistence = new PostgresAgentFeedPersistence(pool);
  const { baseUrl, server } = await startApi(context, persistence);
  return { pool, persistence, baseUrl, server };
}

function skipReason(): string | false {
  return databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live PostgreSQL ingress is required for this gate";
}

function assert2xx(result: HttpResult, message: string): void {
  assert.ok(result.response.status >= 200 && result.response.status < 300, `${message}: ${result.response.status} ${result.raw}`);
}

function assertConflict(result: HttpResult, message: string): void {
  assert.equal(result.response.status, 409, `${message}: ${result.response.status} ${result.raw}`);
}

async function rowCount(pool: PgPool, table: string, runId?: string): Promise<number> {
  const allowed = new Set(["runs", "batches", "findings", "submitted_evidence", "outbox_events"]);
  assert.ok(allowed.has(table), "test only permits known Agent Feed tables");
  if (runId === undefined) {
    const result = await pool.query<{ count: string }>(`select count(*)::text as count from agent_feed.${table}`);
    return Number(result.rows[0]?.count ?? 0);
  }
  if (table === "runs") {
    const result = await pool.query<{ count: string }>(
      "select count(*)::text as count from agent_feed.runs where wire_run_id = $1",
      [runId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  if (table === "outbox_events") {
    const result = await pool.query<{ count: string }>(
      "select count(*)::text as count from agent_feed.outbox_events where wire_run_id = $1",
      [runId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from agent_feed.${table} item
       join agent_feed.runs run on run.id = item.run_id
      where run.wire_run_id = $1`,
    [runId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

test("live REST ingress is durable, idempotent, terminally immutable, and atomically outboxed", {
  skip: skipReason(),
}, async (context) => {
  const { pool, baseUrl, server } = await setup(context);
  const begin = beginPayload();
  const beginHeaders = { ...auth(TEST_SECRET_A), "content-type": "application/json" };

  const health = await jsonRequest(baseUrl, "/health");
  assert.equal(health.response.status, 200, health.raw);
  assert.equal(record(health.body).protocolVersion ?? record(health.body).protocol_version, "0.1");
  assert.equal(record(health.body).ok, true);

  const readiness = await jsonRequest(baseUrl, "/ready");
  assert.equal(readiness.response.status, 200, `readiness: ${readiness.response.status} ${readiness.raw}`);

  const unauthorizedBefore = await rowCount(pool, "runs");
  const unauthorized = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    body: JSON.stringify(begin),
  });
  assert.equal(unauthorized.response.status, 401, unauthorized.raw);
  assert.equal(await rowCount(pool, "runs"), unauthorizedBefore, "unauthorized request must not mutate storage");

  const firstBegin = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(begin),
  });
  assert2xx(firstBegin, "begin");
  const runId = bodyRun(firstBegin.body).run_id as string;
  assert.equal(bodyRun(firstBegin.body).run_id, runId);
  const retriedBegin = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(begin),
  });
  assert2xx(retriedBegin, "exact begin retry");
  assert.deepEqual(bodyRun(retriedBegin.body), bodyRun(firstBegin.body), "exact begin retry must return the original result");
  assert.equal(await rowCount(pool, "runs", runId), 1);
  assert.equal(await rowCount(pool, "outbox_events", runId), 1, "begin and its run.started event commit together");

  const beginDrift = { ...begin, metadata: { changed: true } };
  const driftBegin = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(beginDrift),
  });
  assertConflict(driftBegin, "begin payload drift");
  assert.equal(await rowCount(pool, "runs", runId), 1, "begin drift must not create a second run");

  const batch = batchPayload(runId);
  const batchHeaders = beginHeaders;
  const firstBatch = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers: batchHeaders,
    body: JSON.stringify(batch),
  });
  assert2xx(firstBatch, "submit batch");
  const retriedBatch = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers: batchHeaders,
    body: JSON.stringify(batch),
  });
  assert2xx(retriedBatch, "exact batch retry");
  assert.deepEqual(bodyRun(retriedBatch.body), bodyRun(firstBatch.body), "exact batch retry must return the original result");
  assert.equal(await rowCount(pool, "batches", runId), 1);
  assert.equal(await rowCount(pool, "findings", runId), 1);
  assert.equal(await rowCount(pool, "submitted_evidence", runId), 1);
  assert.equal(await rowCount(pool, "outbox_events", runId), 2, "the accepted batch and finding event commit atomically");

  const batchDrift = { ...batch, metadata: { changed: true } };
  const driftBatch = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers: batchHeaders,
    body: JSON.stringify(batchDrift),
  });
  assertConflict(driftBatch, "batch payload drift");
  assert.equal(await rowCount(pool, "batches", runId), 1);
  assert.equal(await rowCount(pool, "outbox_events", runId), 2);

  const invalidAtomicBatch = batchPayload(runId, {
    batch_id: fixtureId("invalid-batch"),
    idempotency_key: fixtureId("invalid-batch-key"),
    findings: [findingPayload(fixtureId("invalid-finding"), ["missing-evidence"])],
    evidence: [],
  });
  const invalidAtomic = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers: batchHeaders,
    body: JSON.stringify(invalidAtomicBatch),
  });
  assert.ok(invalidAtomic.response.status >= 400 && invalidAtomic.response.status < 500, invalidAtomic.raw);
  assert.equal(await rowCount(pool, "batches", runId), 1, "failed batch must not leave an accepted batch row");
  assert.equal(await rowCount(pool, "findings", runId), 1, "failed batch must not leave a finding row");
  assert.equal(await rowCount(pool, "submitted_evidence", runId), 1, "failed batch must not leave an evidence row");
  assert.equal(await rowCount(pool, "outbox_events", runId), 2, "failed batch must not leave an outbox event");

  const complete = completePayload(runId);
  const firstComplete = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}:complete`, {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(complete),
  });
  assert2xx(firstComplete, "complete");
  assert.equal(bodyRun(firstComplete.body).status, "completed");
  const retriedComplete = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}:complete`, {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(complete),
  });
  assert2xx(retriedComplete, "exact complete retry");
  assert.deepEqual(bodyRun(retriedComplete.body), bodyRun(firstComplete.body), "exact complete retry must return the original result");
  assert.equal(await rowCount(pool, "outbox_events", runId), 3, "completion and its terminal event commit atomically");

  const completeDrift = {
    ...complete,
    errors: [{ code: "different", message: "different terminal payload", source_id: null, retryable: false }],
  };
  const driftComplete = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}:complete`, {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(completeDrift),
  });
  assertConflict(driftComplete, "complete payload drift");
  const terminalMutation = { ...complete, idempotency_key: fixtureId("different-terminal-key"), status: "partial" };
  const terminalChange = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}:complete`, {
    method: "POST",
    headers: beginHeaders,
    body: JSON.stringify(terminalMutation),
  });
  assertConflict(terminalChange, "terminal run must be immutable");
  assert.equal(await rowCount(pool, "outbox_events", runId), 3);

  const fetchedRun = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, { headers: auth(TEST_SECRET_A) });
  assert.equal(fetchedRun.response.status, 200, fetchedRun.raw);
  assert.equal(bodyRun(fetchedRun.body).status, "completed");
  const findings = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/findings`, { headers: auth(TEST_SECRET_A) });
  assert.equal(findings.response.status, 200, findings.raw);
  assert.equal(bodyFindings(findings.body).length, 1);

  // Stop the in-process fixture and start the executable composition root in
  // a new OS process. This exercises environment credentials, migrations,
  // startup, SIGTERM cleanup, and a fresh PostgreSQL pool.
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  const restarted = await startApiProcess(context);
  const restartedRun = await jsonRequest(restarted.baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, { headers: auth(TEST_SECRET_A) });
  assert.equal(restartedRun.response.status, 200, restartedRun.raw);
  assert.deepEqual(bodyRun(restartedRun.body), bodyRun(fetchedRun.body), "restart must preserve the completed run");
  const restartedFindings = await jsonRequest(restarted.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/findings`, { headers: auth(TEST_SECRET_A) });
  assert.equal(restartedFindings.response.status, 200, restartedFindings.raw);
  assert.deepEqual(bodyFindings(restartedFindings.body), bodyFindings(findings.body), "restart must preserve findings");
});

test("live REST ingress proves completed-zero queryability and scoped tenant/producer/stream authorization", {
  skip: skipReason(),
}, async (context) => {
  const { pool, baseUrl } = await setup(context);
  const begin = beginPayload({
    idempotency_key: fixtureId("zero-begin"),
  });
  const headersA = { ...auth(TEST_SECRET_A), "content-type": "application/json" };
  const headersB = { ...auth(TEST_SECRET_B), "content-type": "application/json" };

  const beginResult = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(begin),
  });
  assert2xx(beginResult, "zero-finding begin");
  const runId = bodyRun(beginResult.body).run_id as string;
  const completed = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}:complete`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(completeZeroPayload(runId)),
  });
  assert2xx(completed, "zero-finding complete");
  assert.equal(bodyRun(completed.body).stats && (bodyRun(completed.body).stats as Record<string, unknown>).findings_submitted, 0);

  const query = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, { headers: auth(TEST_SECRET_A) });
  assert.equal(query.response.status, 200, query.raw);
  assert.equal(bodyRun(query.body).status, "completed");
  const zeroFindings = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/findings`, { headers: auth(TEST_SECRET_A) });
  assert.equal(zeroFindings.response.status, 200, zeroFindings.raw);
  assert.deepEqual(bodyFindings(zeroFindings.body), [], "completed-zero run must be queryable as an empty result");

  const runsBeforeScopeCases = await rowCount(pool, "runs");
  const wrongStream = beginPayload({
    stream_id: STREAM_B,
    idempotency_key: fixtureId("wrong-stream"),
  });
  const wrongStreamResult = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(wrongStream),
  });
  assert.equal(wrongStreamResult.response.status, 403, wrongStreamResult.raw);
  assert.equal(await rowCount(pool, "runs"), runsBeforeScopeCases, "wrong stream must be rejected before mutation");

  const wrongProducer = beginPayload({
    producer: {
      producer_id: PRODUCER_B,
      type: "automation",
      name: "m1-ingress-producer-b",
      version: "1",
    },
    idempotency_key: fixtureId("wrong-producer"),
  });
  const wrongProducerResult = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(wrongProducer),
  });
  assert.equal(wrongProducerResult.response.status, 403, wrongProducerResult.raw);
  assert.equal(await rowCount(pool, "runs"), runsBeforeScopeCases, "wrong producer must be rejected before mutation");

  const foreignGet = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, { headers: auth(TEST_SECRET_B) });
  assert.ok([403, 404].includes(foreignGet.response.status), foreignGet.raw);
  const foreignFindings = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/findings`, { headers: auth(TEST_SECRET_B) });
  assert.ok([403, 404].includes(foreignFindings.response.status), foreignFindings.raw);

  const foreignBatch = batchPayload(runId, {
    idempotency_key: fixtureId("foreign-batch"),
    findings: [],
    evidence: [],
  });
  const foreignBatchResult = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers: headersB,
    body: JSON.stringify(foreignBatch),
  });
  assert.ok([403, 404].includes(foreignBatchResult.response.status), foreignBatchResult.raw);
  assert.equal(await rowCount(pool, "batches", runId), 0);
});

test("live REST ingress rejects invalid schema, oversized bodies, and secret-bearing evidence before mutation", {
  skip: skipReason(),
}, async (context) => {
  const { pool, baseUrl } = await setup(context);
  const headers = { ...auth(TEST_SECRET_A), "content-type": "application/json" };
  const runsBefore = await rowCount(pool, "runs");

  const malformedSchema = beginPayload();
  delete malformedSchema.producer;
  const malformed = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers,
    body: JSON.stringify(malformedSchema),
  });
  assert.ok([400, 422].includes(malformed.response.status), malformed.raw);
  assert.equal(await rowCount(pool, "runs"), runsBefore, "schema-invalid begin must not mutate storage");

  const oversized = beginPayload({ metadata: { oversized: "x".repeat(2 * 1024 * 1024) } });
  const oversizedResult = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers,
    body: JSON.stringify(oversized),
  });
  assert.equal(oversizedResult.response.status, 413, oversizedResult.raw);
  assert.equal(await rowCount(pool, "runs"), runsBefore, "oversized begin must not mutate storage");

  const begin = beginPayload();
  const beginResult = await jsonRequest(baseUrl, "/v1/runs:begin", {
    method: "POST",
    headers,
    body: JSON.stringify(begin),
  });
  assert2xx(beginResult, "security fixture begin");
  const runId = bodyRun(beginResult.body).run_id as string;
  const secretEvidence = evidencePayload(fixtureId("secret-evidence"), {
    handling: {
      contains_personal_data: false,
      contains_secrets: true,
      redistribution_restricted: false,
    },
  });
  const secretFinding = findingPayload(fixtureId("secret-finding"), [secretEvidence.evidence_id as string]);
  const secretBatch = batchPayload(runId, {
    idempotency_key: fixtureId("secret-batch"),
    batch_id: fixtureId("secret-batch-id"),
    findings: [secretFinding],
    evidence: [secretEvidence],
  });
  const secretResult = await jsonRequest(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/batches`, {
    method: "POST",
    headers,
    body: JSON.stringify(secretBatch),
  });
  assert.equal(secretResult.response.status, 422, secretResult.raw);
  assert.equal(await rowCount(pool, "batches", runId), 0, "secret-bearing evidence must be rejected before mutation");
  assert.equal(await rowCount(pool, "findings", runId), 0);
  assert.equal(await rowCount(pool, "submitted_evidence", runId), 0);
  assert.equal(await rowCount(pool, "outbox_events", runId), 1, "only run.started may exist after rejected batch");
});

test("live REST ingress enforces producer rate limits with Retry-After", {
  skip: skipReason(),
}, async (context) => {
  const pool = createAgentFeedPool(databaseUrl);
  context.after(async () => pool.end());
  await migrateAgentFeed(pool);
  const { baseUrl } = await startApi(
    context,
    new PostgresAgentFeedPersistence(pool),
    { max_requests_per_minute: 1, burst: 1 },
  );

  const first = await jsonRequest(baseUrl, "/v1/runs/missing_rate_limit_run", {
    headers: auth(TEST_SECRET_A),
  });
  assert.equal(first.response.status, 404, first.raw);

  const limited = await jsonRequest(baseUrl, "/v1/runs/missing_rate_limit_run", {
    headers: auth(TEST_SECRET_A),
  });
  assert.equal(limited.response.status, 429, limited.raw);
  assert.match(limited.response.headers.get("retry-after") ?? "", /^\d+$/u);
});
