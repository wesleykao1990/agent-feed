import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  createAgentFeedPool,
  migrateAgentFeed,
  PostgresAgentFeedPersistence,
} from "@agent-feed/persistence-postgres";
import {
  ProducerService,
  StaticProducerAuthenticator,
} from "@agent-feed/producer-service";
import {
  ProducerCredentialVerifier,
  createMcpHttpGateway,
  createNodeGatewayServer,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_MCP_DATABASE_URL;

function modernParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "m6-postgres-acceptance", version: "1" },
    },
  };
}

function begin(streamId: string, producerId: string, suffix: string): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    idempotency_key: `begin-${suffix}`,
    stream_id: streamId,
    producer: { producer_id: producerId, type: "claude", name: "Claude acceptance", version: "1" },
    task: { task_type: "m6.remote-mcp.acceptance", definition_id: null, definition_version: null },
    expected_scope: { source_ids: ["m6-source"], subjects: ["m6-integration"], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: { acceptance: "m6" },
  };
}

function batch(runId: string, suffix: string): Record<string, unknown> {
  const evidenceId = `evidence-${suffix}`;
  return {
    protocol_version: "0.1",
    run_id: runId,
    batch_id: `batch-${suffix}`,
    idempotency_key: `batch-key-${suffix}`,
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [{
      finding_id: `finding-${suffix}`,
      finding_type: "monitor.change",
      title: "Remote MCP acceptance finding",
      summary: "A bounded non-sensitive observation persisted through Streamable HTTP.",
      subjects: [{ type: "subject", id: "m6-integration", name: "M6 integration" }],
      effective_time: { occurred_at: "2026-08-18T00:00:01.000Z", effective_from: null, effective_to: null },
      assessment: { novelty: "new", source_authority_claim: "official_secondary", evidence_completeness: "complete", agent_confidence: 0.8 },
      evidence_refs: [evidenceId],
      producer_dedupe_key: null,
      routing_tags: ["m6"],
      attributes: {},
      security_flags: [],
    }],
    evidence: [{
      evidence_id: evidenceId,
      kind: "api",
      source: { uri: "https://example.invalid/m6", title: "M6 source", publisher: "Agent Feed", source_id: "m6-source" },
      captured_at: "2026-08-18T00:00:01.000Z",
      published_at: null,
      locator: { type: "url", value: "https://example.invalid/m6", page: null },
      excerpt: "A bounded, non-sensitive observation.",
      content_hash: null,
      artifact: { uri: null, media_type: null, size_bytes: null },
      handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
      metadata: {},
    }],
    metadata: {},
  };
}

function complete(runId: string, suffix: string): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    run_id: runId,
    idempotency_key: `complete-${suffix}`,
    status: "completed",
    completed_at: "2026-08-18T00:00:02.000Z",
    actual_scope: { source_ids: ["m6-source"], subjects: ["m6-integration"], queries: [], metadata: {} },
    stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 1, batches_submitted: 1 },
    errors: [],
    metadata: {},
  };
}

async function toolCall(endpoint: URL, secret: string, id: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: modernParams({ name, arguments: args }) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.error, undefined, JSON.stringify(body));
  const result = body.result as Record<string, unknown>;
  assert.equal(result.isError, undefined, JSON.stringify(body));
  return result.structuredContent as Record<string, unknown>;
}

test("remote MCP persists a complete authenticated lifecycle through the Node listener", {
  skip: databaseUrl === undefined ? "set AGENT_FEED_MCP_DATABASE_URL to a dedicated disposable PostgreSQL database" : false,
}, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const tenantId = `m6-tenant-${suffix}`;
  const producerId = `m6-producer-${suffix}`;
  const streamId = `m6.stream-${suffix}`;
  const secret = `m6-secret-${suffix}`;
  const pool = createAgentFeedPool(databaseUrl);
  await migrateAgentFeed(pool);
  const persistence = new PostgresAgentFeedPersistence(pool);
  const service = new ProducerService({
    persistence,
    authenticator: new StaticProducerAuthenticator([{ tenant_id: tenantId, producer_id: producerId, secret, allowed_stream_ids: [streamId] }]),
  });
  const publicUrl = new URL("http://127.0.0.1/mcp");
  const gateway = createMcpHttpGateway({ public_url: publicUrl, service, verifier: new ProducerCredentialVerifier(service, publicUrl) });
  const server = createNodeGatewayServer({ gateway, request_origin: new URL("http://127.0.0.1") });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

    const running = await toolCall(endpoint, secret, "begin", "begin_run", begin(streamId, producerId, suffix));
    const runId = String(running.run_id);
    assert.match(runId, /\S/u);
    await toolCall(endpoint, secret, "batch", "submit_batch", batch(runId, suffix));
    const terminal = await toolCall(endpoint, secret, "complete", "complete_run", complete(runId, suffix));
    assert.equal(terminal.status, "completed");

    const stored = await persistence.getRunForTenant(tenantId, runId);
    assert.ok(stored);
    assert.equal(stored.status, "completed");
    assert.equal(stored.producer_id, producerId);
    assert.equal(stored.stream_id, streamId);
    assert.equal(stored.findings.length, 1);
    assert.equal(stored.evidence.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.close();
    await pool.end();
  }
});
