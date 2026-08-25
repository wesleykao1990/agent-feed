import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);
const bundleUrl = new URL("../../../api/hosted.bundle.mjs", import.meta.url);

test("Vercel deterministically rebuilds the hosted MCP bundle behind a diagnostic boundary", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const installCommand = config.installCommand as string;
  const buildCommand = config.buildCommand as string;

  assert.doesNotMatch(installCommand, /esbuild/);
  assert.match(buildCommand, /packages\/schema run build/);
  assert.match(buildCommand, /esbuild@0\.25\.9/);
  assert.match(buildCommand, /apps\/mcp-http\/src\/hosted\.ts/);
  assert.match(buildCommand, /--outfile=api\/hosted\.bundle\.mjs/);
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, undefined);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /createRequire\(import\.meta\.url\)/);
  assert.match(entrypoint, /await import\("\.\/hosted\.bundle\.mjs"\)/);
  assert.match(entrypoint, /stage: "hosted_bundle_evaluation"/);
  assert.match(entrypoint, /error_message:/);
  assert.doesNotMatch(entrypoint, /@agent-feed\//);

  const bundle = await readFile(bundleUrl, "utf8");
  assert.doesNotMatch(bundle, /bundle_placeholder_loaded/);
  assert.match(bundle, /hostedAgentFeedFetch/);
});
