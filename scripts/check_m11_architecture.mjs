import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

export function checkM11Architecture() {
  const failures = [];
  const required = (source, marker, label) => {
    if (!source.includes(marker)) failures.push(`${label} missing ${marker}`);
  };

  const packageJson = JSON.parse(read("packages/provider-conformance-core/package.json"));
  if (packageJson.name !== "@agent-feed/provider-conformance-core" || packageJson.version !== "0.1.1") {
    failures.push("provider-conformance-core identity must remain frozen at 0.1.1");
  }
  for (const [dependency, expected] of Object.entries({
    "@agent-feed/assessment-core": "file:../assessment-core",
    "@agent-feed/job-registry-core": "file:../job-registry-core",
  })) {
    if (packageJson.dependencies?.[dependency] !== expected) failures.push(`provider contract must consume exact ${dependency}`);
  }

  const core = [
    read("packages/provider-conformance-core/src/types.ts"),
    read("packages/provider-conformance-core/src/normalize.ts"),
    read("packages/provider-conformance-core/src/matrix.ts"),
  ].join("\n");
  for (const marker of [
    "agent-feed.provider-conformance.v1",
    "agent-feed.provider-conformance-matrix.v1",
    "minimumTopologies = 3",
    "complete_proof_layers_required",
    "terminal_comparison_required",
    "externalInvocationDigest",
    "exact_metric_inventory_required",
  ]) required(core, marker, "provider-neutral conformance contract");
  for (const forbidden of ["externalInvocationId", "providerRunId", "providerTaskId", "rawPayload", "promptBody", "credential"]) {
    if (core.includes(forbidden)) failures.push(`provider-neutral core unexpectedly contains ${forbidden}`);
  }

  const fixtures = read("packages/provider-conformance-core/test/topologies.test.ts");
  for (const marker of [
    "ChatGPTManualExportAdapter",
    "ClaudeHookAdapter",
    "createLifecycleToolRouter",
    "RestProducerAdapter",
    "LocalFileRunBundleAdapter",
    "matrix.topologyCount, 5",
  ]) required(fixtures, marker, "provider topology fixture");

  const protocol = ["begin-run.schema.json", "submit-batch.schema.json", "complete-run.schema.json", "run-envelope.schema.json"]
    .map((name) => read(`packages/schema/contracts/${name}`)).join("\n");
  for (const forbidden of ["provider_conformance", "conformance_receipt", "external_invocation_digest"]) {
    if (protocol.toLowerCase().includes(forbidden)) failures.push(`protocol 0.1 unexpectedly contains ${forbidden}`);
  }
  const producer = [read("packages/producer-service/src/service.ts"), read("apps/api/src/index.ts"), read("apps/mcp-server/src/tools.ts")].join("\n");
  for (const forbidden of ["submitProviderConformance", "buildProviderConformanceMatrix", "providerConformanceReceipt"]) {
    if (producer.includes(forbidden)) failures.push(`producer surface unexpectedly exposes ${forbidden}`);
  }

  const workflow = read(".github/workflows/ci.yml");
  for (const marker of [
    "milestone-11-provider-conformance",
    "npm --prefix packages/provider-conformance-core ci",
    "npm run m11:conformance",
  ]) required(workflow, marker, "CI workflow");

  const milestone = read("docs/23_milestone_11_multi_provider_conformance.md");
  for (const marker of [
    "synthetic adapter",
    "No live ChatGPT Scheduled Task",
    "Unsupported telemetry",
    "No Rewards Optimizer",
    "M10 remains incomplete",
  ]) required(milestone, marker, "M11 record");

  if (failures.length > 0) throw new Error(`M11 architecture failed:\n- ${failures.join("\n- ")}`);
  return 15;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`M11 provider-conformance architecture checks passed (${checkM11Architecture()} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M11 architecture failed");
    process.exitCode = 1;
  }
}
