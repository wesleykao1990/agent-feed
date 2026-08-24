import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);
const placeholderUrl = new URL("../../../api/hosted.bundle.mjs", import.meta.url);

test("Vercel overwrites a checked-in bundle placeholder during install and statically traces it", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const installCommand = config.installCommand as string;

  assert.equal(config.buildCommand, undefined);
  assert.match(installCommand, /esbuild@0\.25\.9/);
  assert.match(installCommand, /apps\/mcp-http\/src\/hosted\.ts/);
  assert.match(installCommand, /--bundle/);
  assert.match(installCommand, /--outfile=api\/hosted\.bundle\.mjs/);
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, undefined);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /import \{ hostedAgentFeedFetch \} from "\.\/hosted\.bundle\.mjs";/);
  assert.doesNotMatch(entrypoint, /import\("\.\/hosted\.bundle\.mjs"\)/);
  assert.doesNotMatch(entrypoint, /@agent-feed\//);
  assert.doesNotMatch(entrypoint, /apps\/mcp-http\/src\/hosted\.ts/);

  const placeholder = await readFile(placeholderUrl, "utf8");
  assert.match(placeholder, /bundle_placeholder_loaded/);
});
