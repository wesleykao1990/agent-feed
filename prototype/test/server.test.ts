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
