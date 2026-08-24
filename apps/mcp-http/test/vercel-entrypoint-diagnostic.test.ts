import assert from "node:assert/strict";
import test from "node:test";
import gateway from "../api/gateway.ts";

test("Vercel gateway returns 404 without rewrite marker before loading Agent Feed runtime", async () => {
  const response = await gateway.fetch(new Request("https://example.test/api/gateway"));
  assert.equal(response.status, 404);
});
