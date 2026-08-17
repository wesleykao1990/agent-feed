import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createAgentFeedServer } from "../src/server.ts";

const token = "test-token";
const bundle = readFileSync(
  new URL("../../examples/run-bundle.zero-findings.example.json", import.meta.url),
  "utf8",
);

test("REST bundle intake authenticates, imports, retries, and exposes the run", async (context) => {
  const server = createAgentFeedServer({ token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const base = "http://127.0.0.1:" + address.port;

  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json() as any).protocolVersion, "0.1");

  const unauthorized = await fetch(base + "/import-run-bundle", {
    method: "POST",
    body: bundle,
    headers: { "content-type": "application/json" },
  });
  assert.equal(unauthorized.status, 401);

  const request = () =>
    fetch(base + "/import-run-bundle", {
      method: "POST",
      body: bundle,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
    });
  const imported = await request();
  const retried = await request();
  assert.equal(imported.status, 201);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json() as any).imported, false);

  const run = await fetch(base + "/runs/run_zero_findings_20260817_001", {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(run.status, 200);
  assert.equal((await run.json() as any).status, "completed");
});

test("REST bundle intake rejects a credential outside its stream scope", async (context) => {
  const server = createAgentFeedServer({
    credentials: [
      {
        producerId: "openai-monitor-jp",
        secret: "scoped-secret",
        allowedStreamIds: ["allowed.stream"],
      },
    ],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const payload = JSON.parse(bundle);
  payload.begin.stream_id = "forbidden.stream";
  const response = await fetch(`http://127.0.0.1:${address.port}/import-run-bundle`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      authorization: "Bearer scoped-secret",
      "content-type": "application/json",
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "unauthorized_stream" });
});

test("REST ingress maps per-producer rate exhaustion to 429", async (context) => {
  const server = createAgentFeedServer({ token, rateLimit: { maxRequestsPerMinute: 1 } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/runs/unknown`;
  const headers = { authorization: "Bearer " + token };
  assert.equal((await fetch(url, { headers })).status, 404);
  const limited = await fetch(url, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: "rate_limited" });
});

test("REST bundle intake rejects secret-bearing evidence before persistence", async (context) => {
  const server = createAgentFeedServer({ token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const source = readFileSync(
    new URL("../../examples/rewards-optimizer/run-bundle.example.json", import.meta.url),
    "utf8",
  );
  const populated = JSON.parse(source);
  populated.batches[0].evidence[0].handling.contains_secrets = true;
  const response = await fetch(`http://127.0.0.1:${address.port}/import-run-bundle`, {
    method: "POST",
    body: JSON.stringify(populated),
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "secret_bearing_evidence_rejected" });
  const run = await fetch(`http://127.0.0.1:${address.port}/runs/${populated.run_id}`, {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(run.status, 404);
});
