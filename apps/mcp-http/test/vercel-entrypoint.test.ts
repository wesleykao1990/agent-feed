import assert from "node:assert/strict";
import test from "node:test";
import gateway from "../api/gateway.ts";

test("Vercel gateway exposes a Web Standard fetch handler", () => {
  assert.equal(typeof gateway, "object");
  assert.equal(typeof gateway.fetch, "function");
});
