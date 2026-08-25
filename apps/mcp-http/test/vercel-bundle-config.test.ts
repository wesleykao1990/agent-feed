import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);
const bundleUrl = new URL("../../../api/hosted.bundle.mjs", import.meta.url);

test("Vercel statically imports a checked-in self-contained hosted MCP bundle", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const installCommand = config.installCommand as string;

  assert.equal(config.buildCommand, undefined);
  assert.doesNotMatch(installCommand, /esbuild/);
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, undefined);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /import \{ hostedAgentFeedFetch \} from "\.\/hosted\.bundle\.mjs";/);
  assert.doesNotMatch(entrypoint, /import\("\.\/hosted\.bundle\.mjs"\)/);
  assert.doesNotMatch(entrypoint, /@agent-feed\//);

  const bundle = await readFile(bundleUrl, "utf8");
  assert.doesNotMatch(bundle, /bundle_placeholder_loaded/);
  assert.match(bundle, /hostedAgentFeedFetch/);
});
