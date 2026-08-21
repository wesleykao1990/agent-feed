import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  ProducerService,
  ProducerServiceError,
  StaticProducerAuthenticator,
  type BeginRunRequest,
  type CompleteRunRequest,
  type ProducerPersistence,
  type ProducerPrincipal,
  type RunRecord,
  type SubmitBatchRequest,
} from "@agent-feed/producer-service";
import {
  MCP_TOOL_NAMES,
  createOfficialMcpServer,
  createOfficialMcpServerFromEnvironment,
  safeToolError,
  serveAgentFeedMcpStdio,
} from "../src/index.ts";
import { AgentFeedMcpServer } from "../src/server.ts";
import {
  authorizationFromEnvironment,
  credentialsFromEnvironment,
} from "../src/composition.ts";
import type { JsonRpcResponse, ProducerServiceBoundary } from "../src/types.ts";

const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant_a",
  producer_id: "producer_a",
  allowed_stream_ids: ["stream.a"],
};

const BEGIN = {
  protocol_version: "0.1",
  idempotency_key: "begin-idempotency-a",
  stream_id: "stream.a",
  producer: { producer_id: "producer_a", type: "automation", name: "fixture", version: "1" },
  task: { task_type: "monitor", definition_id: null, definition_version: null },
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
  started_at: "2026-08-18T00:00:00.000Z",
  parent_run_id: null,
  metadata: {},
};

function success(response: JsonRpcResponse): Record<string, unknown> {
  assert.equal("result" in response, true);
  return (response as { result: Record<string, unknown> }).result;
}

function rpcError(response: JsonRpcResponse): { code: number; message: string; data?: Record<string, unknown> } {
  assert.equal("error" in response, true);
  return (response as { error: { code: number; message: string; data?: Record<string, unknown> } }).error;
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "fixture-modern-client", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...params, _meta: MODERN_META };
}

function nextJsonLine(output: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      output.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    };
    output.on("data", onData);
  });
}

class FakeService implements ProducerServiceBoundary {
  readonly calls: Array<{ operation: string; value: unknown; principal: ProducerPrincipal; runId?: string }> = [];
  readonly rateCalls: ProducerPrincipal[] = [];
  authCalls: string[] = [];
  result: unknown = { run_id: "run_aaaaaaaa", status: "running" };
  failure: unknown;

  beginRun(value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    this.calls.push({ operation: "begin", value, principal });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }

  submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    this.calls.push({ operation: "submit", runId, value, principal });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }

  completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown> {
    this.calls.push({ operation: "complete", runId, value, principal });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }

  assertRateAllowed(principal: ProducerPrincipal): void {
    this.rateCalls.push(principal);
  }

  authenticate(request: { authorization?: string }): ProducerPrincipal {
    this.authCalls.push(request.authorization ?? "");
    if (request.authorization !== "Bearer fixture-secret") throw new ProducerServiceError("unauthorized");
    return PRINCIPAL;
  }
}

function initialized(server: AgentFeedMcpServer): Promise<JsonRpcResponse | null> {
  return server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fixture-client", version: "1" },
    },
  });
}

test("initialize negotiates MCP and tools/list exposes exactly the three published lifecycle tools", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  const init = await initialized(server);
  assert.ok(init);
  const initResult = success(init);
  assert.equal(initResult.protocolVersion, "2024-11-05");
  assert.deepEqual(initResult.capabilities, { tools: { listChanged: false } });

  const listed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(listed);
  const tools = success(listed).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), [...MCP_TOOL_NAMES]);
  assert.equal((tools[0]?.inputSchema as Record<string, unknown>).additionalProperties, false);
  assert.equal((tools[1]?.inputSchema as Record<string, unknown>).$id, "https://agent-feed.dev/schemas/submit-batch.schema.json");
  const submitSchema = tools[1]?.inputSchema as Record<string, unknown>;
  assert.deepEqual(submitSchema.required, [
    "protocol_version",
    "run_id",
    "batch_id",
    "idempotency_key",
    "sequence_number",
    "submitted_at",
    "findings",
    "evidence",
    "metadata",
  ]);
  assert.deepEqual(
    Object.keys(submitSchema.properties as Record<string, unknown>).sort(),
    [
      "batch_id",
      "evidence",
      "findings",
      "idempotency_key",
      "metadata",
      "protocol_version",
      "run_id",
      "sequence_number",
      "submitted_at",
    ],
  );
  assert.equal("anyOf" in submitSchema, false);
});

test("modern MCP discovery and requests use the per-request envelope without initialize", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  const discover = await server.handleMessage({
    jsonrpc: "2.0",
    id: "discover-1",
    method: "server/discover",
    params: modernParams(),
  });
  assert.ok(discover);
  const discoverResult = success(discover);
  assert.equal(discoverResult.resultType, "complete");
  assert.deepEqual(discoverResult.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discoverResult.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(discoverResult._meta, {
    "io.modelcontextprotocol/serverInfo": { name: "agent-feed-mcp", version: "0.1.1" },
  });

  const listed = await server.handleMessage({
    jsonrpc: "2.0",
    id: "modern-list",
    method: "tools/list",
    params: modernParams(),
  });
  assert.ok(listed);
  const listResult = success(listed);
  assert.equal(listResult.resultType, "complete");
  assert.deepEqual((listResult.tools as Array<Record<string, unknown>>).map((tool) => tool.name), [...MCP_TOOL_NAMES]);
  assert.equal((listResult._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"] !== undefined, true);

  const missingEnvelope = await server.handleMessage({
    jsonrpc: "2.0",
    id: "modern-missing-meta",
    method: "tools/list",
  });
  assert.ok(missingEnvelope);
  assert.deepEqual(rpcError(missingEnvelope), {
    code: -32602,
    message: "Invalid _meta envelope",
    data: { error: "modern_envelope_required" },
  });
});

test("official SDK serveStdio factory serves modern discovery and legacy initialize", async () => {
  const service = new FakeService();
  const options = { service, principal: PRINCIPAL };

  const modernInput = new PassThrough();
  const modernOutput = new PassThrough();
  const modernErrors: Error[] = [];
  const modernTransport = new StdioServerTransport(modernInput, modernOutput);
  const modernHandle = serveAgentFeedMcpStdio(options, {
    transport: modernTransport,
    onerror: (error) => modernErrors.push(error),
  });
  const modernResponse = nextJsonLine(modernOutput);
  modernInput.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: modernParams() }) + "\n");
  const discover = await modernResponse;
  assert.equal((discover.result as Record<string, unknown>).resultType, "complete");
  assert.deepEqual((discover.result as Record<string, unknown>).supportedVersions, ["2026-07-28"]);
  assert.equal(modernErrors.length, 0);

  const modernListResponse = nextJsonLine(modernOutput);
  modernInput.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: modernParams() }) + "\n");
  const modernList = await modernListResponse;
  const modernTools = (modernList.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(modernTools.map((tool) => tool.name), [...MCP_TOOL_NAMES]);
  assert.equal((modernList.result as Record<string, unknown>).resultType, "complete");
  assert.equal((modernList.result as Record<string, unknown>).ttlMs, 0);
  assert.deepEqual((modernList.result as Record<string, unknown>)._meta, {
    "io.modelcontextprotocol/serverInfo": { name: "agent-feed-mcp", version: "0.1.1" },
  });

  const modernCallResponse = nextJsonLine(modernOutput);
  modernInput.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: modernParams({ name: "begin_run", arguments: BEGIN }),
  }) + "\n");
  const modernCall = await modernCallResponse;
  assert.equal((modernCall.result as Record<string, unknown>).resultType, "complete");
  assert.equal((modernCall.result as Record<string, unknown>).isError, undefined);
  assert.deepEqual(service.calls.map((call) => call.operation), ["begin"]);

  service.failure = new Error("password=modern-secret sql internals");
  const failedCallResponse = nextJsonLine(modernOutput);
  modernInput.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: modernParams({ name: "begin_run", arguments: {} }),
  }) + "\n");
  const failedCall = await failedCallResponse;
  const failedContent = ((failedCall.result as Record<string, unknown>).content as Array<{ text: string }>)[0]!.text;
  assert.deepEqual(JSON.parse(failedContent), { error: "internal_error" });
  assert.equal(JSON.stringify(failedCall).includes("modern-secret"), false);
  await modernHandle.close();
  modernInput.destroy();
  modernOutput.destroy();

  const legacyInput = new PassThrough();
  const legacyOutput = new PassThrough();
  const legacyErrors: Error[] = [];
  const legacyTransport = new StdioServerTransport(legacyInput, legacyOutput);
  const legacyHandle = serveAgentFeedMcpStdio(options, {
    transport: legacyTransport,
    onerror: (error) => legacyErrors.push(error),
  });
  const legacyInitResponse = nextJsonLine(legacyOutput);
  legacyInput.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture-legacy-client", version: "1" },
    },
  }) + "\n");
  const legacyInit = await legacyInitResponse;
  assert.equal((legacyInit.result as Record<string, unknown>).protocolVersion, "2025-11-25");
  assert.equal((legacyInit.result as Record<string, unknown>).resultType, undefined);
  const legacyListResponse = nextJsonLine(legacyOutput);
  legacyInput.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  const legacyList = await legacyListResponse;
  assert.deepEqual((legacyList.result as Record<string, unknown>).tools && ((legacyList.result as Record<string, unknown>).tools as Array<Record<string, unknown>>).map((tool) => tool.name), [...MCP_TOOL_NAMES]);
  assert.equal((legacyList.result as Record<string, unknown>).resultType, undefined);
  assert.equal(legacyErrors.length, 0);
  await legacyHandle.close();
  legacyInput.destroy();
  legacyOutput.destroy();

  // The low-level SDK server is also directly constructible for embedders;
  // executable stdio uses serveStdio above so it can select either era.
  assert.equal(createOfficialMcpServer(options).getCapabilities().tools !== undefined, true);
});

test("tool calls delegate all lifecycle operations to the injected service and principal", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  await initialized(server);

  const begin = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "begin_run", arguments: BEGIN } });
  const submit = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_batch", arguments: { run_id: "run_aaaaaaaa", idempotency_key: "batch-key-a" } } });
  const complete = await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "complete_run", arguments: { run_id: "run_aaaaaaaa", idempotency_key: "complete-key-a" } } });

  assert.equal("error" in (begin!), false);
  assert.equal("error" in (submit!), false);
  assert.equal("error" in (complete!), false);
  assert.deepEqual(service.calls.map((call) => call.operation), ["begin", "submit", "complete"]);
  assert.equal(service.calls[1]?.runId, "run_aaaaaaaa");
  assert.equal(service.calls[2]?.runId, "run_aaaaaaaa");
  assert.equal(service.rateCalls.length, 3);
  assert.deepEqual(service.calls[0]?.principal, PRINCIPAL);
  const callResult = success(begin!).content as Array<{ type: string; text: string }>;
  assert.deepEqual(JSON.parse(callResult[0]!.text), service.result);
});

test("authorization is resolved outside tool arguments and invalid credentials fail closed", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, authorization: "Bearer fixture-secret" });
  await initialized(server);
  const result = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "begin_run", arguments: {} } });
  assert.ok(result);
  assert.deepEqual(service.authCalls, ["Bearer fixture-secret"]);

  const invalid = new AgentFeedMcpServer({ service, authorization: "Bearer wrong-secret" });
  await initialized(invalid);
  const rejected = await invalid.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "begin_run", arguments: {} } });
  assert.ok(rejected);
  const content = success(rejected).content as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(content[0]!.text), { error: "unauthorized" });
  assert.equal(content[0]!.text.includes("wrong-secret"), false);
});

test("invalid tool calls use deterministic JSON-RPC errors without calling the service or echoing secrets", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  await initialized(server);

  const malformed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_batch", arguments: [] } });
  assert.ok(malformed);
  assert.deepEqual(rpcError(malformed), { code: -32602, message: "Invalid params", data: { error: "invalid_tool_arguments" } });
  assert.equal(service.calls.length, 0);

  const secret = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "begin_run", arguments: { secret: "do-not-return" } } });
  assert.ok(secret);
  const secretError = rpcError(secret);
  assert.deepEqual(secretError.data, { error: "authentication_fields_are_not_tool_arguments" });
  assert.equal(JSON.stringify(secretError).includes("do-not-return"), false);

  const unknown = await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  assert.ok(unknown);
  assert.deepEqual(rpcError(unknown), { code: -32602, message: "Invalid params", data: { error: "unknown_tool" } });
  assert.equal(service.calls.length, 0);
});

test("service and adapter failures are bounded to stable MCP tool error codes", async () => {
  const service = new FakeService();
  service.failure = new Error("password=super-secret internal sql detail");
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  await initialized(server);
  const failed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "begin_run", arguments: {} } });
  assert.ok(failed);
  const content = success(failed).content as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(content[0]!.text), { error: "internal_error" });
  assert.equal(JSON.stringify(failed).includes("super-secret"), false);
  assert.equal(JSON.stringify(failed).includes("sql"), false);

  service.failure = new ProducerServiceError("idempotency_payload_conflict", "secret payload details");
  const conflict = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "begin_run", arguments: {} } });
  assert.ok(conflict);
  const conflictContent = success(conflict).content as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(conflictContent[0]!.text), { error: "idempotency_payload_conflict" });
  assert.equal(JSON.stringify(conflict).includes("secret payload"), false);
});

test("stdio transport emits one response per request, ignores notifications, and returns parse errors", async () => {
  const service = new FakeService();
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const serving = server.start(input, output);
  input.end([
    "not-json",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n") + "\n");
  await serving;
  const responses = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(responses.length, 3);
  assert.deepEqual(responses[0]?.error, { code: -32700, message: "Parse error" });
  assert.equal(responses[1]?.id, 1);
  assert.equal(responses[2]?.id, 2);
});

class IntegrationPersistence implements ProducerPersistence {
  readonly runs = new Map<string, RunRecord>();
  readonly begins: BeginRunRequest[] = [];
  readonly submits: SubmitBatchRequest[] = [];
  readonly completes: CompleteRunRequest[] = [];

  async beginRun(input: BeginRunRequest): Promise<RunRecord> {
    this.begins.push(input);
    const created = integrationRun(input.tenant_id ?? "tenant_a");
    this.runs.set(created.run_id, created);
    return created;
  }

  async submitBatch(input: SubmitBatchRequest): Promise<RunRecord> {
    this.submits.push(input);
    const run = this.runs.get(input.run_id);
    if (!run) throw new Error("run_missing");
    return run;
  }

  async completeRun(input: CompleteRunRequest): Promise<RunRecord> {
    this.completes.push(input);
    const run = this.runs.get(input.run_id);
    if (!run) throw new Error("run_missing");
    return run;
  }

  async getRunForTenant(tenantId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run?.tenant_id === tenantId ? run : null;
  }
}

function integrationRun(tenantId: string): RunRecord {
  return {
    run_id: "run_aaaaaaaa",
    tenant_id: tenantId,
    trace_id: "trace_aaaaaaaa",
    stream_id: "stream.a",
    producer_id: "producer_a",
    begin_idempotency_key: "begin-idempotency-a",
    begin_payload_hash: "hash",
    complete_idempotency_key: null,
    complete_payload_hash: null,
    status: "running",
    started_at: "2026-08-18T00:00:00.000Z",
    completed_at: null,
    envelope: {} as RunRecord["envelope"],
    batches: [],
    findings: [],
    evidence: [],
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
  };
}

function validEvidence(id: string): Record<string, unknown> {
  return {
    evidence_id: id,
    kind: "web",
    source: { uri: "https://example.invalid/source", title: "Fixture", publisher: "Fixture", source_id: "fixture" },
    captured_at: "2026-08-18T00:00:01.000Z",
    published_at: null,
    locator: null,
    excerpt: "bounded fixture excerpt",
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
    metadata: {},
  };
}

test("integration uses the concrete ProducerService validation and scope boundary", async () => {
  const persistence = new IntegrationPersistence();
  const service = new ProducerService({
    persistence,
    authenticator: new StaticProducerAuthenticator([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "fixture-secret", allowed_stream_ids: ["stream.a"] }]),
  });
  const server = new AgentFeedMcpServer({ service, principal: PRINCIPAL });
  await initialized(server);

  const created = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "begin_run", arguments: BEGIN } });
  assert.ok(created);
  assert.equal("isError" in success(created), false);
  assert.equal(persistence.begins.length, 1);
  assert.equal(persistence.begins[0]?.tenant_id, "tenant_a");

  const invalid = await server.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "begin_run", arguments: { ...BEGIN, streamId: "stream.a" } },
  });
  assert.ok(invalid);
  const invalidContent = success(invalid).content as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(invalidContent[0]!.text), {
    error: "schema_validation_failed",
    issues: [{ path: "$", code: "unexpected_field" }],
  });
  assert.equal(persistence.begins.length, 1);

  const batch = await server.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "submit_batch",
      arguments: {
        protocol_version: "0.1",
        run_id: "run_aaaaaaaa",
        batch_id: "batch_001",
        idempotency_key: "batch-idempotency-a",
        sequence_number: 1,
        submitted_at: "2026-08-18T00:00:01.000Z",
        findings: [],
        evidence: [validEvidence("evidence_001")],
        metadata: {},
      },
    },
  });
  assert.ok(batch);
  assert.equal("isError" in success(batch), false);
  assert.equal(persistence.submits.length, 1);

  const completed = await server.handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "complete_run",
      arguments: {
        protocol_version: "0.1",
        run_id: "run_aaaaaaaa",
        idempotency_key: "complete-idempotency-a",
        status: "completed",
        completed_at: "2026-08-18T00:00:02.000Z",
        actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
        stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 1, batches_submitted: 1 },
        errors: [],
        metadata: {},
      },
    },
  });
  assert.ok(completed);
  assert.equal("isError" in success(completed), false);
  assert.equal(persistence.completes.length, 1);
});

test("schema failures expose bounded repair diagnostics without service details", () => {
  const diagnostic = safeToolError(new ProducerServiceError(
    "schema_validation_failed",
    "raw validation message must stay private",
    {
      details: {
        errors: [
          { path: "/findings/0/effective_time/effective_from", message: 'must match format "date-time"' },
          { path: "$.attributes.secret", message: "must be a string" },
          { path: "/evidence/0/source/uri", message: 'must match format "uri"' },
        ],
      },
    },
  ));
  assert.deepEqual(JSON.parse(diagnostic.content[0]!.text), {
    error: "schema_validation_failed",
    issues: [
      { path: "/findings/0/effective_time/effective_from", code: "invalid_date_time" },
      { path: "$", code: "invalid_type" },
      { path: "/evidence/0/source/uri", code: "invalid_uri" },
    ],
  });
  assert.deepEqual(diagnostic.structuredContent, JSON.parse(diagnostic.content[0]!.text));
  assert.equal(diagnostic.content[0]!.text.includes("raw validation message"), false);
  assert.equal(diagnostic.content[0]!.text.includes("secret"), false);
});

test("schema repair diagnostics stop after eight safe issues", () => {
  const diagnostic = safeToolError(new ProducerServiceError(
    "schema_validation_failed",
    "private aggregate message",
    {
      details: {
        errors: Array.from({ length: 12 }, (_, index) => ({
          path: `/findings/${index}/effective_time/effective_from`,
          message: 'must match format "date-time"',
        })),
      },
    },
  ));
  const body = diagnostic.structuredContent as { issues: Array<{ path: string; code: string }> };
  assert.equal(body.issues.length, 8);
  assert.deepEqual(body.issues.at(-1), {
    path: "/findings/7/effective_time/effective_from",
    code: "invalid_date_time",
  });
});

test("environment composition parses scoped credentials without exposing secrets", () => {
  const env = {
    AGENT_FEED_PRODUCER_CREDENTIALS: JSON.stringify([{ tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["stream.a"] }]),
  };
  const credentials = credentialsFromEnvironment(env);
  assert.deepEqual(credentials[0], { tenant_id: "tenant_a", producer_id: "producer_a", secret: "secret-a", allowed_stream_ids: ["stream.a"] });
  assert.equal(authorizationFromEnvironment(credentials, env), "Bearer secret-a");
  assert.throws(() => credentialsFromEnvironment({ AGENT_FEED_PRODUCER_CREDENTIALS: "not-json-secret" }), /invalid_producer_credentials/u);
  assert.throws(() => authorizationFromEnvironment([
    credentials[0]!,
    { ...credentials[0]!, producer_id: "producer_b", secret: "secret-b" },
  ], {}), /mcp_authorization_required/u);

  const fake = new FakeService();
  const official = createOfficialMcpServerFromEnvironment({ service: fake, principal: PRINCIPAL, env });
  assert.equal(official.getCapabilities().tools !== undefined, true);
});

test("tunnel launcher keeps MCP stdout free of package-manager banners", async () => {
  const launcher = await readFile(
    new URL("../bin/agent-feed-mcp-stdio", import.meta.url),
    "utf8",
  );

  assert.match(launcher, /exec node --experimental-strip-types src\/main\.ts/u);
  assert.doesNotMatch(launcher, /\bnpm\b|\bpnpm\b|\byarn\b/u);
  assert.doesNotMatch(launcher, /\becho\b|\bprintf\b/u);
});
