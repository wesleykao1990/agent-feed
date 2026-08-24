import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);

test("Vercel gateway bundle explicitly includes the hosted MCP runtime closure", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const includeFiles = config.functions?.["api/gateway.ts"]?.includeFiles;
  assert.equal(
    includeFiles,
    "{apps/mcp-http/**,apps/mcp-server/**,packages/**}",
  );
});
