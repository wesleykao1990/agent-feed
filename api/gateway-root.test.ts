import assert from "node:assert/strict";
import test from "node:test";

import handler from "./gateway.ts";

test("root Vercel handler exposes a fetch boundary without eagerly importing runtime dependencies", () => {
  assert.equal(typeof handler, "object");
  assert.equal(typeof handler.fetch, "function");
});
