import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);

test("Vercel builds and statically imports a self-contained hosted MCP bundle", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const installCommand = config.installCommand as string;
  const buildCommand = config.buildCommand as string;

  assert.doesNotMatch(installCommand, /esbuild/);
  assert.match(buildCommand, /esbuild@0\.25\.9/);
  assert.match(buildCommand, /apps\/mcp-http\/src\/hosted\.ts/);
  assert.match(buildCommand, /--bundle/);
  assert.match(buildCommand, /--outfile=api\/hosted\.bundle\.mjs/);
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, undefined);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /import \{ hostedAgentFeedFetch \} from "\.\/hosted\.bundle\.mjs";/);
  assert.doesNotMatch(entrypoint, /import\("\.\/hosted\.bundle\.mjs"\)/);
  assert.doesNotMatch(entrypoint, /@agent-feed\//);
  assert.doesNotMatch(entrypoint, /apps\/mcp-http\/src\/hosted\.ts/);
});
