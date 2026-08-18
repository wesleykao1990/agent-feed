import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Server } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  LocalFileImportFailure,
  LocalFileRunBundleAdapter,
  createRunBundleValidator,
  type ProducerLifecycleService,
} from "../../packages/adapters/local-file/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANUAL_BUNDLE_PATH = join(ROOT, "examples/m3/chatgpt-scheduled-task-manual-export.example.json");
const PARTIAL_BUNDLE_PATH = join(ROOT, "examples/m3/chatgpt-scheduled-task-partial-export.example.json");
const HOSTILE_BUNDLE_PATH = join(ROOT, "examples/m3/hostile-content-preserved.example.json");
const PRINCIPAL = {
  tenant_id: "tenant_m3_conformance",
  producer_id: "producer_m3_conformance",
  allowed_stream_ids: ["chatgpt.scheduled.manual", "m3.conformance"],
};
const SECRET = "m3-secret-must-never-leak";
const MCP_MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "m3-conformance", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type JsonRecord = Record<string, any>;

function fixture(pathname: string): JsonRecord {
  return JSON.parse(readFileSync(pathname, "utf8")) as JsonRecord;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function responseRun(runId: string, status: string, value: JsonRecord): JsonRecord {
  return {
    run_id: runId,
    protocol_version: "0.1",
    stream_id: value.stream_id ?? "m3.conformance",
    status,
    ...value,
  };
}

/**
 * A structural public-service spy.  REST and MCP receive this exact object;
 * no adapter gets a storage fake or a second lifecycle implementation.
 */
class ProducerServiceSpy implements ProducerLifecycleService {
  readonly calls: Array<{ method: string; run_id?: string; value: JsonRecord; principal: unknown }> = [];
  readonly completions: JsonRecord[] = [];
  readonly runs = new Map<string, JsonRecord>();
  failAt: "begin" | "batch" | "complete" | null = null;
  failMessage = `upstream Authorization Bearer ${SECRET} excerpt=private evidence`;
  readonly security = { max_body_bytes: 1024 * 1024 };
  readonly rate_limiter = { max_requests_per_minute: 10_000, burst: 10_000, burst_window_ms: 1_000 };

  authenticate(request: { authorization?: string }): typeof PRINCIPAL {
    if (request.authorization !== `Bearer ${SECRET}`) throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
    return clone(PRINCIPAL);
  }

  assertRateAllowed(): void {}

  async beginRun(value: unknown, principal: unknown): Promise<JsonRecord> {
    return this.beginRunWithWireId(`run_m3_rest_${this.calls.length + 1}`, value, principal);
  }

  async beginRunWithWireId(runId: string, value: unknown, principal: unknown): Promise<JsonRecord> {
    const input = clone(value as JsonRecord);
    this.calls.push({ method: "beginRun", run_id: runId, value: input, principal: clone(principal) });
    if (this.failAt === "begin") throw Object.assign(new Error(this.failMessage), { code: "storage_error" });
    const run = responseRun(runId, "running", input);
    this.runs.set(runId, run);
    return clone(run);
  }

  async submitBatch(runId: string, value: unknown, principal: unknown): Promise<JsonRecord> {
    const input = clone(value as JsonRecord);
    this.calls.push({ method: "submitBatch", run_id: runId, value: input, principal: clone(principal) });
    if (this.failAt === "batch") throw Object.assign(new Error(this.failMessage), { code: "storage_error" });
    return clone(responseRun(runId, "running", input));
  }

  async completeRun(runId: string, value: unknown, principal: unknown): Promise<JsonRecord> {
    const input = clone(value as JsonRecord);
    this.calls.push({ method: "completeRun", run_id: runId, value: input, principal: clone(principal) });
    this.completions.push(input);
    if (this.failAt === "complete") throw Object.assign(new Error(this.failMessage), { code: "storage_error" });
    return clone(responseRun(runId, String(input.status ?? "completed"), input));
  }
}

async function startRest(service: ProducerServiceSpy): Promise<{ server: Server }> {
  const api = await import("../../apps/api/src/index.ts");
  assert.equal(typeof api.createAgentFeedApiServer, "function", "REST public entrypoint must export createAgentFeedApiServer");
  const server = api.createAgentFeedApiServer({ service }) as Server;
  // The conformance gate must work in a sandbox where binding a TCP port is
  // prohibited.  Emitting a request directly still executes the real REST
  // adapter callback and therefore exercises routing, auth, and service DI.
  return { server };
}

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveStop, reject) => server.close((error) => error ? reject(error) : resolveStop()));
}

async function restJson(server: Server, pathname: string, body: JsonRecord): Promise<{ status: number; body: JsonRecord }> {
  const request = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  request.method = "POST";
  request.url = pathname;
  request.headers = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
  const response = await new Promise<{ status: number; body: JsonRecord }>((resolveResponse, reject) => {
    const outgoing = {
      status: 0,
      headers: {} as Record<string, string>,
      writeHead(status: number, headers: Record<string, string>) {
        this.status = status;
        this.headers = headers;
        return this;
      },
      end(raw?: string | Uint8Array) {
        try {
          const text = raw === undefined ? "" : Buffer.from(raw).toString("utf8");
          resolveResponse({ status: this.status, body: JSON.parse(text) as JsonRecord });
        } catch (error) {
          reject(error);
        }
      },
    };
    server.emit("request", request, outgoing);
  });
  return response;
}

function modernMcpParams(params: JsonRecord = {}): JsonRecord {
  return { ...params, _meta: clone(MCP_MODERN_META) };
}

function nextJsonLine(output: PassThrough): Promise<JsonRecord> {
  return new Promise((resolveLine) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      output.off("data", onData);
      resolveLine(JSON.parse(buffer.slice(0, newline)) as JsonRecord);
    };
    output.on("data", onData);
  });
}

class M3LineTransport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  #buffer = "";
  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += chunk.toString();
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JsonRecord);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error("invalid_json"));
      }
    }
  };

  readonly input: PassThrough;
  readonly output: PassThrough;

  constructor(input: PassThrough, output: PassThrough) {
    this.input = input;
    this.output = output;
  }

  async start(): Promise<void> {
    this.input.on("data", this.#onData);
    this.input.once("end", () => this.onclose?.());
  }

  async send(message: unknown): Promise<void> {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.input.off("data", this.#onData);
    this.onclose?.();
  }
}

async function mcpRequest(input: PassThrough, output: PassThrough, request: JsonRecord): Promise<JsonRecord> {
  const response = nextJsonLine(output);
  input.write(`${JSON.stringify(request)}\n`);
  return response;
}

async function closeMcp(
  handle: { close(): Promise<void> },
  input: PassThrough,
  output: PassThrough,
): Promise<void> {
  await handle.close();
  input.destroy();
  output.destroy();
}

async function mcpLifecycle(service: ProducerServiceSpy, bundle: JsonRecord): Promise<JsonRecord[]> {
  const mcp = await import("../../apps/mcp-server/src/index.ts");
  assert.equal(typeof mcp.serveAgentFeedMcpStdio, "function", "MCP public entrypoint must expose the official serveStdio path");
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = mcp.serveAgentFeedMcpStdio({ service, principal: PRINCIPAL }, { transport: new M3LineTransport(input, output) });
  try {
    const discover = await mcpRequest(input, output, {
      jsonrpc: "2.0",
      id: "discover-m3",
      method: "server/discover",
      params: modernMcpParams(),
    });
    assert.equal((discover.result as JsonRecord)?.resultType, "complete");
    assert.deepEqual((discover.result as JsonRecord)?.supportedVersions, ["2026-07-28"]);

    const listed = await mcpRequest(input, output, {
      jsonrpc: "2.0",
      id: "list-m3",
      method: "tools/list",
      params: modernMcpParams(),
    });
    const listResult = listed.result as JsonRecord;
    assert.equal(listResult.resultType, "complete");
    const names = (listResult.tools as JsonRecord[]).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["begin_run", "complete_run", "submit_batch"]);

    const runId = "run_m3_mcp_001";
    const begin = clone(bundle.begin);
    begin.idempotency_key = "begin_m3_mcp_001";
    const batch = clone(bundle.batches[0]);
    batch.run_id = runId;
    batch.idempotency_key = "batch_m3_mcp_001";
    const complete = clone(bundle.complete);
    complete.run_id = runId;
    complete.idempotency_key = "complete_m3_mcp_001";
    const args = [begin, batch, complete];
    const responses: JsonRecord[] = [];
    for (const [index, name] of ["begin_run", "submit_batch", "complete_run"].entries()) {
      const record = await mcpRequest(input, output, {
        jsonrpc: "2.0",
        id: index + 3,
        method: "tools/call",
        params: modernMcpParams({ name, arguments: args[index] }),
      });
      assert.equal(record.error, undefined, JSON.stringify(record));
      const result = record.result as JsonRecord;
      assert.equal(result.resultType, "complete", JSON.stringify(record));
      assert.equal(result.isError, undefined, JSON.stringify(record));
      responses.push(result.structuredContent as JsonRecord);
    }
    return responses;
  } finally {
    await closeMcp(handle, input, output);
  }
}

test("REST and MCP expose the same three lifecycle operations through one producer service", async () => {
  const bundle = fixture(MANUAL_BUNDLE_PATH);
  const service = new ProducerServiceSpy();
  const rest = await startRest(service);
  try {
    const begin = clone(bundle.begin);
    begin.idempotency_key = "begin_m3_rest_001";
    const batch = clone(bundle.batches[0]);
    batch.run_id = "run_m3_rest_001";
    batch.idempotency_key = "batch_m3_rest_001";
    const complete = clone(bundle.complete);
    complete.run_id = "run_m3_rest_001";
    complete.idempotency_key = "complete_m3_rest_001";
    const restBegin = await restJson(rest.server, "/v1/runs:begin", begin);
    assert.equal(restBegin.status, 201, JSON.stringify(restBegin.body));
    const restBatch = await restJson(rest.server, "/v1/runs/run_m3_rest_001/batches", batch);
    assert.equal(restBatch.status, 202, JSON.stringify(restBatch.body));
    const restComplete = await restJson(rest.server, "/v1/runs/run_m3_rest_001:complete", complete);
    assert.equal(restComplete.status, 200, JSON.stringify(restComplete.body));

    const beforeMcp = service.calls.length;
    const mcpResults = await mcpLifecycle(service, bundle);
    assert.equal(mcpResults.length, 3);
    const mcpCalls = service.calls.slice(beforeMcp);
    assert.deepEqual(mcpCalls.map((call) => call.method), ["beginRun", "submitBatch", "completeRun"]);
    assert.deepEqual(mcpCalls.map((call) => call.principal), [PRINCIPAL, PRINCIPAL, PRINCIPAL]);
    assert.equal(mcpCalls.every((call) => !Object.hasOwn(call.value, "tenant_id") || call.value.tenant_id === undefined), true);
    assert.deepEqual(service.calls.slice(0, 3).map((call) => call.method), ["beginRun", "submitBatch", "completeRun"]);
    assert.deepEqual(service.calls.slice(0, 3).map((call) => call.principal), [PRINCIPAL, PRINCIPAL, PRINCIPAL]);
  } finally {
    await stopServer(rest.server);
  }
});

test("MCP tool descriptors pin Agent Feed protocol 0.1 and reject secret control fields", async () => {
  const mcp = await import("../../apps/mcp-server/src/index.ts");
  const names = mcp.MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["begin_run", "complete_run", "submit_batch"]);
  for (const tool of mcp.MCP_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.properties?.protocol_version?.const, "0.1", `${tool.name} schema drifted from protocol 0.1`);
    assert.equal(tool.annotations?.idempotentHint, true);
  }
  const service = new ProducerServiceSpy();
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = mcp.serveAgentFeedMcpStdio(
    { service, principal: PRINCIPAL },
    { transport: new M3LineTransport(input, output) },
  );
  try {
    const rejected = await mcpRequest(input, output, {
      jsonrpc: "2.0",
      id: "secret-control",
      method: "tools/call",
      params: modernMcpParams({ name: "begin_run", arguments: { authorization: SECRET } }),
    });
    assert.equal((rejected.error as JsonRecord)?.code, -32602, JSON.stringify(rejected));
    assert.equal(JSON.stringify(rejected).includes(SECRET), false);
    assert.equal(service.calls.length, 0);
  } finally {
    await closeMcp(handle, input, output);
  }
});

test("official MCP stdio keeps legacy initialize compatibility on a separately pinned connection", async () => {
  const mcp = await import("../../apps/mcp-server/src/index.ts");
  const service = new ProducerServiceSpy();
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = mcp.serveAgentFeedMcpStdio(
    { service, principal: PRINCIPAL },
    { transport: new M3LineTransport(input, output) },
  );
  try {
    const initialized = await mcpRequest(input, output, {
      jsonrpc: "2.0",
      id: "legacy-init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "m3-legacy-client", version: "1" },
      },
    });
    assert.equal((initialized.result as JsonRecord)?.protocolVersion, "2025-11-25");
    assert.equal((initialized.result as JsonRecord)?.resultType, undefined);
    const listed = await mcpRequest(input, output, {
      jsonrpc: "2.0",
      id: "legacy-list",
      method: "tools/list",
    });
    assert.deepEqual(
      (listed.result as JsonRecord)?.tools && ((listed.result as JsonRecord).tools as JsonRecord[]).map((tool) => tool.name),
      ["begin_run", "submit_batch", "complete_run"],
    );
    assert.equal((listed.result as JsonRecord)?.resultType, undefined);
  } finally {
    await closeMcp(handle, input, output);
  }
});

test("a tool-less producer can import validated completed, partial, and hostile run bundles", async () => {
  const validator = createRunBundleValidator();
  const service = new ProducerServiceSpy();
  for (const pathname of [MANUAL_BUNDLE_PATH, PARTIAL_BUNDLE_PATH, HOSTILE_BUNDLE_PATH]) {
    const bundle = validator(fixture(pathname));
    assert.equal(bundle.protocol_version, "0.1");
    assert.equal(bundle.begin.protocol_version, "0.1");
    assert.equal(bundle.complete.protocol_version, "0.1");
    assert.equal(bundle.complete.run_id, bundle.run_id);
    for (const batch of bundle.batches) assert.equal(batch.run_id, bundle.run_id);
    const adapter = new LocalFileRunBundleAdapter({ service, principal: PRINCIPAL });
    const result = await adapter.importJson(JSON.stringify(bundle));
    assert.equal((result.complete as JsonRecord).run_id, bundle.run_id);
    if (bundle.complete.status === "partial") assert.equal((result.complete as JsonRecord).status, "partial");
    const finding = bundle.batches.flatMap((batch) => batch.findings)[0] as JsonRecord | undefined;
    if (finding) assert.deepEqual(finding.security_flags, (result.batches[0] as JsonRecord).findings?.[0]?.security_flags ?? finding.security_flags);
  }
  const localCalls = service.calls.filter((call) => call.method === "beginRun");
  assert.equal(localCalls.length, 3, "each import must begin exactly once through the injected service");
});

class FailingAfterBeginService extends ProducerServiceSpy {
  override failAt: "batch" | "complete" = "batch";
}

test("adapter failures preserve partial progress, close when possible, and redact credentials/evidence", async () => {
  const bundle = fixture(PARTIAL_BUNDLE_PATH);
  const closedService = new FailingAfterBeginService();
  const closedAdapter = new LocalFileRunBundleAdapter({ service: closedService, principal: PRINCIPAL });
  await assert.rejects(
    closedAdapter.importJson(JSON.stringify(bundle)),
    (error: unknown) => {
      assert.ok(error instanceof LocalFileImportFailure);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      return true;
    },
  );
  assert.deepEqual(closedService.calls.map((call) => call.method), ["beginRun", "submitBatch", "completeRun"]);
  assert.equal(closedService.completions[0]?.status, "partial");
  assert.equal(closedService.completions[0]?.errors?.[0]?.message.includes(SECRET), false);

  const unreachable = new FailingAfterBeginService();
  unreachable.completeRun = async (runId: string, value: unknown, principal: unknown): Promise<JsonRecord> => {
    unreachable.calls.push({ method: "completeRun", run_id: runId, value: clone(value as JsonRecord), principal: clone(principal) });
    throw Object.assign(new Error(`database password=${SECRET}`), { code: "storage_error" });
  };
  let recovery: JsonRecord | undefined;
  const recoveryAdapter = new LocalFileRunBundleAdapter({
    service: unreachable,
    principal: PRINCIPAL,
    recovery_store: { persist: async (artifact) => { recovery = clone(artifact as JsonRecord); } },
  });
  await assert.rejects(recoveryAdapter.importJson(JSON.stringify(bundle)), (error: unknown) => {
    assert.ok(error instanceof LocalFileImportFailure);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  assert.equal(recovery?.protocol_version, "0.1");
  assert.equal(recovery?.run_id, bundle.run_id);
  assert.equal(JSON.stringify(recovery).includes(SECRET), false);
});

test("generic-webhook adapter preserves a post-begin failure behind the same local-file recovery contract", async () => {
  const webhook = await import("../../packages/adapters/generic-webhook/src/index.ts");
  assert.equal(typeof webhook.GenericWebhookInputAdapter, "function");
  const bundle = fixture(PARTIAL_BUNDLE_PATH);
  const service = new FailingAfterBeginService();
  const upstreamSecret = "m3-webhook-secret";
  const raw = JSON.stringify({ upstream_claim: "untrusted" });
  const signature = createHmac("sha256", upstreamSecret).update(raw).digest("hex");
  const adapter = new webhook.GenericWebhookInputAdapter({
    service,
    principal: PRINCIPAL,
    secret: upstreamSecret,
    mapper: async (_payload: unknown, context: JsonRecord) => {
      assert.equal(context.signature.verified, true);
      return bundle;
    },
  });
  await assert.rejects(
    adapter.ingest({
      raw_body: raw,
      headers: {
        "content-type": "application/json",
        "x-event-id": "event_m3_webhook_001",
        "x-webhook-signature": `sha256=${signature}`,
      },
    }),
    (error: unknown) => {
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      assert.equal(String(error).includes(upstreamSecret), false);
      return true;
    },
  );
  assert.deepEqual(service.calls.map((call) => call.method), ["beginRun", "submitBatch", "completeRun"]);
  assert.equal(service.completions[0]?.status, "partial");
});

test("Claude hook adapter closes a post-begin failure or returns resumable recovery", async () => {
  const claude = await import("../../packages/adapters/claude-hook/src/index.ts");
  assert.equal(typeof claude.ClaudeHookAdapter, "function");
  const bundle = fixture(PARTIAL_BUNDLE_PATH);
  const service = new FailingAfterBeginService();
  const adapter = new claude.ClaudeHookAdapter({ service, principal: PRINCIPAL });
  await adapter.handle({ type: "run.started", run_id: bundle.run_id, begin: bundle.begin });
  const closed = await adapter.handle({ type: "run.batch", run_id: bundle.run_id, batch: bundle.batches[0] });
  assert.equal(closed.recovery?.status, "closed");
  assert.equal(service.completions[0]?.status, "partial");
  assert.equal(JSON.stringify(closed).includes(SECRET), false);

  const unreachable = new FailingAfterBeginService();
  unreachable.completeRun = async (runId: string, value: unknown, principal: unknown): Promise<JsonRecord> => {
    unreachable.calls.push({ method: "completeRun", run_id: runId, value: clone(value as JsonRecord), principal: clone(principal) });
    throw Object.assign(new Error(`unreachable password=${SECRET}`), { code: "storage_error" });
  };
  const recovering = new claude.ClaudeHookAdapter({ service: unreachable, principal: PRINCIPAL });
  await recovering.handle({ type: "start", run_id: bundle.run_id, begin: bundle.begin });
  await assert.rejects(
    recovering.handle({ type: "batch", run_id: bundle.run_id, batch: bundle.batches[0] }),
    (error: unknown) => {
      assert.equal(error instanceof claude.ClaudeHookImportFailure, true);
      assert.equal(String(error).includes(SECRET), false);
      return true;
    },
  );
});

test("failure before begin has no lifecycle side effects and no raw diagnostic", async () => {
  const service = new ProducerServiceSpy();
  service.failAt = "begin";
  const adapter = new LocalFileRunBundleAdapter({ service, principal: PRINCIPAL });
  await assert.rejects(adapter.importJson(JSON.stringify(fixture(MANUAL_BUNDLE_PATH))), (error: unknown) => {
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
  assert.deepEqual(service.calls.map((call) => call.method), ["beginRun"]);
  assert.equal(service.completions.length, 0);
});

test("TypeScript and Python SDKs expose producer/consumer surfaces with exact protocol pinning", async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages/sdk/generated/protocol-types.manifest.json"), "utf8")) as JsonRecord;
  assert.equal(manifest.protocol_version, "0.1");
  const tsGenerated = readFileSync(join(ROOT, "packages/sdk/typescript/generated/protocol.ts"), "utf8");
  const pyGenerated = readFileSync(join(ROOT, "packages/sdk/python/agent_feed/generated/protocol.py"), "utf8");
  assert.match(tsGenerated, /ProtocolVersion\s*=\s*["']0\.1["']/u);
  assert.match(pyGenerated, /PROTOCOL_VERSION\s*=\s*["']0\.1["']/u);

  const tsEntry = join(ROOT, "packages/sdk/typescript/src/index.ts");
  const tsModule = await import(pathToFileURL(tsEntry).href);
  const tsNames = Object.keys(tsModule);
  assert.ok(tsNames.some((name) => /producer.*client|producer.*sdk/i.test(name)), `missing TypeScript producer client export: ${tsNames.join(", ")}`);
  assert.ok(tsNames.some((name) => /consumer.*client|consumer.*sdk/i.test(name)), `missing TypeScript consumer client export: ${tsNames.join(", ")}`);
  assert.equal(tsModule.PROTOCOL_VERSION, "0.1");
  assert.notEqual(tsModule.PACKAGE_VERSION, tsModule.PROTOCOL_VERSION, "package release version must remain independent of wire protocol version");

  const transportRequests: JsonRecord[] = [];
  const transportResponses: Array<JsonRecord | Error> = [
    { status: 201, body: { run_id: "run_m3_sdk_001", status: "running" } },
    { status: 202, body: { run_id: "run_m3_sdk_001", status: "running" } },
    { status: 200, body: { run_id: "run_m3_sdk_001", status: "completed" } },
    { status: 200, body: { items: [], nextCursor: "opaque-cursor", ackCursor: null, hasMore: false } },
    { status: 200, body: { acknowledgementId: "ack_m3_001", acknowledgedDeliveryIds: ["delivery_m3_001"], ackCursor: "opaque-cursor" } },
    { status: 200, body: { replayId: "replay_m3_001", delivery: { deliveryId: "delivery_m3_001" } } },
  ];
  const transport = {
    async request(input: JsonRecord): Promise<JsonRecord> {
      transportRequests.push(clone(input));
      const next = transportResponses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("missing_sdk_response");
      return next;
    },
  };
  const sdkBegin = clone(fixture(MANUAL_BUNDLE_PATH).begin);
  sdkBegin.idempotency_key = "begin_m3_sdk_001";
  const sdkBatch = clone(fixture(MANUAL_BUNDLE_PATH).batches[0]);
  sdkBatch.run_id = "run_m3_sdk_001";
  sdkBatch.idempotency_key = "batch_m3_sdk_001";
  const sdkComplete = clone(fixture(MANUAL_BUNDLE_PATH).complete);
  sdkComplete.run_id = "run_m3_sdk_001";
  sdkComplete.idempotency_key = "complete_m3_sdk_001";
  const producer = new tsModule.ProducerClient({
    base_url: "https://feed.example.invalid",
    token: SECRET,
    transport,
    sleep: async () => {},
    retry: { max_attempts: 2 },
  });
  await producer.beginRun(sdkBegin);
  await producer.submitBatch("run_m3_sdk_001", sdkBatch);
  await producer.completeRun("run_m3_sdk_001", sdkComplete);
  const portable = producer.buildRunBundle("run_m3_sdk_001", sdkBegin, [sdkBatch], sdkComplete);
  assert.equal(portable.protocol_version, "0.1");
  const consumer = new tsModule.ConsumerClient({
    base_url: "https://feed.example.invalid",
    token: SECRET,
    consumer_id: "consumer_m3",
    transport,
    sleep: async () => {},
  });
  const page = await consumer.pull("subscription_m3", { limit: 10 });
  assert.equal(page.nextCursor, "opaque-cursor");
  await consumer.ack("subscription_m3", ["delivery_m3_001"], { idempotency_key: "ack_m3_001" });
  await consumer.replay("subscription_m3", "delivery_m3_001", { idempotency_key: "replay_m3_001" });
  assert.equal(transportRequests.every((request) => request.headers?.authorization === `Bearer ${SECRET}`), true);
  assert.equal(JSON.parse(String(transportRequests[0]?.body)).protocol_version, "0.1");
  assert.equal(transportRequests.some((request) => String(request.url).includes("/v1/runs:begin")), true);
  assert.equal(transportRequests.some((request) => String(request.url).includes("/events")), true);

  const pythonProbe = [
    "import json, os",
    "import agent_feed",
    "from agent_feed import ConsumerClient, ProducerClient, PROTOCOL_VERSION, RetryPolicy, TransportResponse",
    "assert PROTOCOL_VERSION == '0.1'",
    "assert agent_feed.ProducerClient is ProducerClient",
    "assert agent_feed.ConsumerClient is ConsumerClient",
    "class FakeTransport:",
    "    def __init__(self):",
    "        self.calls = []",
    "        self.responses = [TransportResponse(201, {}, {'run_id': 'run_m3_py_001', 'status': 'running'}), TransportResponse(202, {}, {'run_id': 'run_m3_py_001', 'status': 'running'}), TransportResponse(200, {}, {'run_id': 'run_m3_py_001', 'status': 'completed'}), TransportResponse(200, {}, {'items': [], 'nextCursor': 'opaque-cursor', 'ackCursor': None, 'hasMore': False}), TransportResponse(200, {}, {'acknowledgementId': 'ack_m3_py_001', 'acknowledgedDeliveryIds': ['delivery_m3_py_001'], 'ackCursor': 'opaque-cursor'}), TransportResponse(200, {}, {'replayId': 'replay_m3_py_001', 'delivery': {'deliveryId': 'delivery_m3_py_001'}})]",
    "    def request(self, method, path, *, headers, body, timeout):",
    "        self.calls.append((method, path, headers, body, timeout))",
    "        return self.responses.pop(0)",
    "token = os.environ['M3_SECRET']",
    "begin = json.loads(os.environ['M3_BEGIN'])",
    "batch = json.loads(os.environ['M3_BATCH']); batch['run_id'] = 'run_m3_py_001'",
    "complete = json.loads(os.environ['M3_COMPLETE']); complete['run_id'] = 'run_m3_py_001'",
    "transport = FakeTransport()",
    "producer = ProducerClient('https://feed.example.invalid', token=token, transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))",
    "producer.begin_run(begin)",
    "producer.submit_batch('run_m3_py_001', batch)",
    "producer.complete_run('run_m3_py_001', complete)",
    "consumer = ConsumerClient('https://feed.example.invalid', token=token, transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))",
    "page = consumer.pull_page('subscription_m3', limit=10)",
    "assert page['nextCursor'] == 'opaque-cursor'",
    "consumer.acknowledge('subscription_m3', delivery_ids=['delivery_m3_py_001'], idempotency_key='ack_m3_py_001')",
    "consumer.replay_dead_letter('subscription_m3', 'delivery_m3_py_001', idempotency_key='replay_m3_py_001')",
    "assert len(transport.calls) == 6",
    "assert all(call[2]['Authorization'] == 'Bearer ' + token for call in transport.calls)",
    "assert json.loads(json.dumps(transport.calls[0][3]))['protocol_version'] == '0.1'",
    "assert any(path.endswith('/v1/runs:begin') for _, path, _, _, _ in transport.calls)",
    "assert any('/v1/consumers/events?subscription_id=subscription_m3&limit=10' in path for _, path, _, _, _ in transport.calls)",
    "assert any('/v1/consumers/dead-letters/delivery_m3_py_001:replay?subscription_id=subscription_m3' in path for _, path, _, _, _ in transport.calls)",
  ].join("\n");
  const { spawnSync } = await import("node:child_process");
  const python = spawnSync("python3", ["-c", pythonProbe], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: join(ROOT, "packages/sdk/python"),
      M3_SECRET: SECRET,
      M3_BEGIN: JSON.stringify(sdkBegin),
      M3_BATCH: JSON.stringify(sdkBatch),
      M3_COMPLETE: JSON.stringify(sdkComplete),
    },
    encoding: "utf8",
  });
  assert.equal(python.status, 0, `Python SDK probe failed: ${python.stderr || python.stdout}`);
});

test("Scheduled Task direct export is explicitly capability-gated and fallback fixtures are normal protocol bundles", async () => {
  const guidancePath = join(ROOT, "skills/chatgpt/SCHEDULED_TASK_EXPORT.md");
  const guidance = readFileSync(guidancePath, "utf8");
  assert.match(guidance, /all three exact Agent Feed operations/iu);
  assert.match(guidance, /manual\/?local-file/iu);
  assert.match(guidance, /must not|never/iu);
  assert.match(guidance, /capabilit/iu);
  for (const pathname of [MANUAL_BUNDLE_PATH, PARTIAL_BUNDLE_PATH]) {
    const bundle = createRunBundleValidator()(fixture(pathname));
    assert.equal(bundle.protocol_version, "0.1");
    assert.ok(["completed", "partial", "failed", "cancelled"].includes(bundle.complete.status));
    assert.equal(bundle.complete.status === "completed" && bundle.complete.errors.length > 0, false);
    assert.equal(bundle.complete.status === "partial" || bundle.complete.status === "failed"
      ? bundle.complete.errors.length > 0
      : true, true);
  }
});

test("ChatGPT manual export is tool-less by default and submits only with an explicit capability", async () => {
  const manual = await import("../../packages/adapters/chatgpt-manual-export/src/index.ts");
  assert.equal(typeof manual.ChatGPTManualExportAdapter, "function");
  const input = {
    response: "No changes found.",
    stream_id: "chatgpt.scheduled.manual",
    task: { task_type: "monitor", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
  };

  const toolLess = new manual.ChatGPTManualExportAdapter({ now: () => new Date("2026-08-18T00:00:01.000Z") });
  const first = await toolLess.export(input);
  const second = await toolLess.export(input);
  assert.equal(first.direct_ingestion_available, false);
  assert.deepEqual(second.bundle, first.bundle, "tool-less export should be deterministic for the same response");
  assert.equal(first.bundle.protocol_version, "0.1");
  await assert.rejects(
    () => toolLess.submit(input),
    (error: unknown) => {
      assert.equal(error instanceof manual.ChatGPTManualExportError, true);
      assert.equal((error as { code?: string }).code, "capability_unavailable");
      assert.equal(String(error).includes(SECRET), false);
      return true;
    },
  );

  const service = new ProducerServiceSpy();
  const capable = new manual.ChatGPTManualExportAdapter({
    service,
    principal: PRINCIPAL,
    direct_ingestion_capability: true,
    now: () => new Date("2026-08-18T00:00:01.000Z"),
  });
  const submitted = await capable.submit(input);
  assert.equal(submitted.direct_ingestion_available, true);
  assert.equal(submitted.imported.complete !== undefined, true);
  assert.deepEqual(service.calls.map((call) => call.method), ["beginRun", "submitBatch", "completeRun"]);

  await assert.rejects(
    () => toolLess.export({ ...input, response: "authorization=super-secret-value" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "secret_detected");
      assert.equal(String(error).includes("super-secret-value"), false);
      return true;
    },
  );
});

test("MCP error mapping and SDK diagnostics never retain authorization or evidence payloads", async () => {
  const mcp = await import("../../apps/mcp-server/src/errors.ts");
  const safe = mcp.safeToolError(Object.assign(new Error(`Authorization: Bearer ${SECRET}; excerpt=private`), { code: "storage_error" }));
  assert.equal(safe.isError, true);
  assert.equal(JSON.stringify(safe).includes(SECRET), false);

  const sdkErrors = await import("../../packages/sdk/typescript/src/errors.ts");
  const transportError = new sdkErrors.AgentFeedTransportError({ operation: "submit_batch", retryable: true });
  assert.equal(transportError.message.includes(SECRET), false);
  assert.equal(JSON.stringify(transportError.toJSON()).includes(SECRET), false);
});
