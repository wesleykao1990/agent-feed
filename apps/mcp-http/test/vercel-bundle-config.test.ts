import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../../../vercel.json", import.meta.url);
const buildScriptUrl = new URL("../../../scripts/vercel_build.sh", import.meta.url);
const entrypointUrl = new URL("../../../api/gateway.ts", import.meta.url);
const bundleUrl = new URL("../../../api/hosted.bundle.mjs", import.meta.url);

test("Vercel deterministically rebuilds the hosted MCP bundle behind diagnostic boundaries", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const installCommand = config.installCommand as string;
  const buildCommand = config.buildCommand as string;
  const buildScript = await readFile(buildScriptUrl, "utf8");

  assert.doesNotMatch(installCommand, /esbuild/);
  assert.equal(buildCommand, "bash scripts/vercel_build.sh");
  assert.equal(config.outputDirectory, "public");
  assert.match(buildScript, /packages\/schema run build/);
  assert.match(buildScript, /esbuild@0\.25\.9/);
  assert.match(buildScript, /apps\/mcp-http\/src\/hosted\.ts/);
  assert.match(buildScript, /--outfile=api\/hosted\.bundle\.mjs/);

  // The bundle lives under api/, and persistence resolves ../migrations/* from
  // import.meta.url, so the migration assets must be staged at repository root.
  assert.match(buildScript, /cp -R packages\/persistence-postgres\/migrations migrations/);
  assert.equal(config.functions?.["api/gateway.ts"]?.includeFiles, "migrations/**");
  assert.match(buildScript, /public\/\.vercel-output-sentinel/);

  const entrypoint = await readFile(entrypointUrl, "utf8");
  assert.match(entrypoint, /publicPath === "\/health"/);
  assert.match(entrypoint, /stage: "gateway_bootstrap"/);
  assert.match(entrypoint, /probeRuntime/);
  assert.match(entrypoint, /"hosted_runtime_probe"/);
  assert.match(entrypoint, /stage = "hosted_bundle_evaluation"/);
  assert.match(entrypoint, /createRequire\(import\.meta\.url\)/);
  assert.match(entrypoint, /await import\("\.\/hosted\.bundle\.mjs"\)/);
  assert.match(entrypoint, /error_message:/);
  assert.doesNotMatch(entrypoint, /@agent-feed\//);

  // hosted.bundle.mjs is intentionally generated and not committed. Build it
  // here so the conformance gate validates the exact artifact Vercel creates.
  execFileSync("bash", ["scripts/vercel_build.sh"], {
    cwd: new URL("../../../", import.meta.url),
    stdio: "pipe",
  });
  const bundle = await readFile(bundleUrl, "utf8");
  assert.doesNotMatch(bundle, /bundle_placeholder_loaded/);
  assert.match(bundle, /hostedAgentFeedFetch/);
  assert.match(bundle, /migrateAgentFeed/);
});
