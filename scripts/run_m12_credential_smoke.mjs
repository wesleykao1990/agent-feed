import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const requested = new Set(process.argv.slice(2));
const runCodex = requested.size === 0 || requested.has("--codex") || requested.has("--all");
const runApi = requested.has("--openai-api") || requested.has("--all") || requested.has("--require-openai-api");
const requireApi = requested.has("--require-openai-api");

function fail(message) { console.error(`[M12 credentials] ${message}`); process.exitCode = 1; }

if (runCodex) {
  const status = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 30_000 });
  if (status.status !== 0) fail("Codex CLI has no usable cached login.");
  else {
    const directory = mkdtempSync(join(tmpdir(), "agent-feed-m12-codex-"));
    const output = join(directory, "result.txt");
    try {
      const result = spawnSync("codex", [
        "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
        "--skip-git-repo-check", "-o", output,
        "Return exactly AGENT_FEED_CODEX_AUTH_OK and nothing else. Do not use tools.",
      ], { cwd: tmpdir(), encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
      const message = result.status === 0 ? readFileSync(output, "utf8").trim() : "";
      if (result.status !== 0 || message !== "AGENT_FEED_CODEX_AUTH_OK") fail("live Codex request failed or returned an unexpected receipt.");
      else console.log("[M12 credentials] live Codex request passed using the configured cached login.");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

if (runApi) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (requireApi) fail("OPENAI_API_KEY is required but is not configured.");
    else console.log("[M12 credentials] OpenAI API-key probe skipped: OPENAI_API_KEY is not configured.");
  } else {
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) fail(`OpenAI API-key probe failed with HTTP ${response.status}.`);
      else {
        await response.body?.cancel();
        console.log("[M12 credentials] OpenAI API-key authentication passed; no model response was generated or persisted.");
      }
    } catch { fail("OpenAI API-key probe could not reach the API."); }
  }
}
