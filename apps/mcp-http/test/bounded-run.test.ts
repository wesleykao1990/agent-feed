import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import {
  AUTH_PRINCIPAL_KEY,
  MCP_WRITE_SCOPE,
  createMcpHttpGateway,
  type AccessTokenVerifier,
} from "../src/index.ts";

const PUBLIC_URL = new URL("https://feed.example/mcp");
const PRINCIPAL: ProducerPrincipal = {
  tenant_id: "tenant-test",
  producer_id: "producer-test",
  allowed_stream_ids: ["stream.a"],
};

class Verifier implements AccessTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    assert.equal(token, "valid-token");
    return {
      token,
      clientId: "client-test",
      scopes: [MCP_WRITE_SCOPE],
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      resource: PUBLIC_URL,
      extra: { [AUTH_PRINCIPAL_KEY]: PRINCIPAL },
    };
  }
}

class Service {
  readonly calls: Array<{ name: string; runId?: string; value: Record<string, unknown> }> = [];
  security = { max_body_bytes: 65_536 };

  async beginRun(value: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ name: "begin", value: value as Record<string, unknown> });
    return { run_id: "run-remote-1", status: "running" };
  }

  async submitBatch(runId: string, value: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ name: "submit", runId, value: value as Record<string, unknown> });
    return { run_id: runId, status: "running" };
  }

  async completeRun(runId: string, value: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ name: "complete", runId, value: value as Record<string, unknown> });
    return { run_id: runId, status: "completed" };
  }
}

function modern(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "bounded-test", version: "1" },
    },
  };
}

function request(body: Record<string, unknown>): Request {
  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : undefined;
  return new Request(PUBLIC_URL, {
    method: "POST",
    headers: {
      host: "feed.example",
      accept: "application/json, text/event-stream",
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "mcp-method": String(body.method ?? ""),
      ...(typeof params?.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("enabled remote gateway advertises and executes submit_bounded_run", async () => {
  const service = new Service();
  const gateway = createMcpHttpGateway({
    public_url: PUBLIC_URL,
    service,
    verifier: new Verifier(),
    enable_bounded_run: true,
  });
  try {
    const listed = await gateway.fetch(request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: modern(),
    }));
    assert.equal(listed.status, 200, await listed.clone().text());
    const listBody = await listed.json() as Record<string, unknown>;
    const names = (((listBody.result as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      .map((tool) => tool.name));
    assert.deepEqual(names, ["begin_run", "submit_batch", "complete_run", "submit_bounded_run"]);

    const called = await gateway.fetch(request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: modern({
        name: "submit_bounded_run",
        arguments: {
          begin: {
            protocol_version: "0.1",
            idempotency_key: "begin-bounded-1",
            stream_id: "stream.a",
            producer: { producer_id: "producer-test", type: "chatgpt", name: "test", version: "1" },
            task: { task_type: "test", definition_id: null, definition_version: null },
            expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
            started_at: "2026-08-25T00:00:00Z",
            parent_run_id: null,
            metadata: {},
          },
          batches: [{
            protocol_version: "0.1",
            batch_id: "batch-bounded-1",
            idempotency_key: "batch-bounded-1",
            sequence_number: 1,
            submitted_at: "2026-08-25T00:00:01Z",
            findings: [],
            evidence: [],
            metadata: {},
          }],
          complete: {
            protocol_version: "0.1",
            idempotency_key: "complete-bounded-1",
            status: "completed",
            completed_at: "2026-08-25T00:00:02Z",
            actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
            stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 1 },
            errors: [],
            metadata: {},
          },
        },
      }),
    }));
    assert.equal(called.status, 200, await called.clone().text());
    const callBody = await called.json() as Record<string, unknown>;
    assert.equal(callBody.error, undefined, JSON.stringify(callBody));
    assert.deepEqual(service.calls.map((call) => call.name), ["begin", "submit", "complete"]);
    assert.equal(service.calls[1]?.runId, "run-remote-1");
    assert.equal(service.calls[2]?.runId, "run-remote-1");
    assert.equal(service.calls[1]?.value.run_id, "run-remote-1");
    assert.equal(service.calls[2]?.value.run_id, "run-remote-1");
  } finally {
    await gateway.close();
  }
});
