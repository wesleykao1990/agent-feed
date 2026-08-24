import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);

test("Vercel gateway uses static dependency tracing instead of includeFiles", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, undefined);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /import \{ hostedAgentFeedFetch \} from "\.\.\/apps\/mcp-http\/src\/hosted\.ts";/);
});
