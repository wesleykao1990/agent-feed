import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AgentFeedStore } from "./store.ts";
import { RunBundleImporter } from "./wire.ts";

export async function importRunBundleFile(path: string) {
  const raw = await readFile(path, "utf8");
  return new RunBundleImporter(new AgentFeedStore()).importJson(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npm run import:file -- <run-bundle.json>");
    process.exitCode = 2;
  } else {
    const result = await importRunBundleFile(path);
    console.log(
      JSON.stringify(
        {
          imported: result.imported,
          payloadHash: result.payloadHash,
          runId: result.run.runId,
          status: result.run.status,
          findings: result.run.findings.length,
          evidence: result.run.evidence.length,
        },
        null,
        2,
      ),
    );
  }
}
