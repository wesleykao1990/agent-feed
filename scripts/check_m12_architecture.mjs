import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const required = (source, marker, label, failures) => { if (!source.includes(marker)) failures.push(`${label} missing ${marker}`); };

export function checkM12Architecture() {
  const failures = [];
  const manifest = JSON.parse(read("packages/utility-feedback-core/package.json"));
  if (manifest.name !== "@agent-feed/utility-feedback-core" || manifest.version !== "0.1.1") failures.push("utility-feedback-core identity must remain frozen at 0.1.1");
  if (manifest.dependencies !== undefined) failures.push("pure utility-feedback contract must not gain runtime package dependencies");

  const core = ["types.ts", "validation.ts", "ledger.ts", "metrics.ts"].map((name) => read(`packages/utility-feedback-core/src/${name}`)).join("\n");
  for (const marker of ["surfaced", "ignored", "duplicate", "invalid", "saved", "acted_on", "promoted", "rejected", "trustedOwner", "idempotency_payload_conflict", "reviewBurden", "sourceYield", "timeToAction", "costPerAccepted", "approvalState: \"pending\"", "consumer_not_allowed"]) required(core, marker, "utility-feedback contract", failures);
  for (const forbidden of ["promptBody", "scheduleBody", "findingSummary", "evidenceBody", "applyRecommendation", "executeRecommendation"]) if (core.includes(forbidden)) failures.push(`utility-feedback core unexpectedly contains ${forbidden}`);

  const protocol = ["begin-run.schema.json", "submit-batch.schema.json", "complete-run.schema.json", "run-envelope.schema.json"].map((name) => read(`packages/schema/contracts/${name}`)).join("\n").toLowerCase();
  for (const forbidden of ["utility_feedback", "disposition", "recommendation_approval"]) if (protocol.includes(forbidden)) failures.push(`protocol 0.1 unexpectedly contains ${forbidden}`);
  const producer = [read("packages/producer-service/src/service.ts"), read("apps/api/src/index.ts"), read("apps/mcp-server/src/tools.ts")].join("\n");
  for (const forbidden of ["submitUtilityFeedback", "applyRecommendation", "recordDisposition"]) if (producer.includes(forbidden)) failures.push(`producer surface unexpectedly exposes ${forbidden}`);

  const workflow = read(".github/workflows/ci.yml");
  for (const marker of ["milestone-12-utility-feedback", "npm --prefix packages/utility-feedback-core ci", "npm run m12:conformance"]) required(workflow, marker, "CI workflow", failures);
  const milestone = read("docs/24_milestone_12_utility_feedback.md");
  for (const marker of ["consumer-owned", "append-only", "cannot rewrite findings", "require separate approval", "No Rewards Optimizer", "not accepted"]) required(milestone, marker, "M12 record", failures);
  if (failures.length) throw new Error(`M12 architecture failed:\n- ${failures.join("\n- ")}`);
  return 14;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`M12 utility-feedback architecture checks passed (${checkM12Architecture()} boundaries checked).`); }
  catch (error) { console.error(error instanceof Error ? error.message : "M12 architecture failed"); process.exitCode = 1; }
}
