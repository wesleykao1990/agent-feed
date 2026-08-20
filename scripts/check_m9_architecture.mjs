import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

export function checkM9Architecture() {
  const failures = [];
  const required = (source, marker, label) => { if (!source.includes(marker)) failures.push(`${label} missing ${marker}`); };
  const corePackage = JSON.parse(read("packages/job-registry-core/package.json"));
  const persistencePackage = JSON.parse(read("packages/persistence-postgres/package.json"));
  if (corePackage.name !== "@agent-feed/job-registry-core" || corePackage.version !== "0.1.1") failures.push("job-registry-core identity must be frozen at 0.1.1");
  if (persistencePackage.dependencies?.["@agent-feed/job-registry-core"] !== "file:../job-registry-core") failures.push("persistence must consume the exact local job-registry-core contract");

  const core = [read("packages/job-registry-core/src/types.ts"), read("packages/job-registry-core/src/validation.ts"), read("packages/job-registry-core/src/preflight.ts")].join("\n");
  for (const marker of ["JobDefinition", "CapabilityProfile", "DeploymentBinding", "evaluateActivationPreflight", "missing_off_switch", "missing_shadow_evidence", "incompatible_capability", "controlled_reference_required"]) required(core, marker, "job-registry core");
  const migration = read("packages/persistence-postgres/migrations/0006_job_registry.sql");
  for (const marker of ["job_definition_versions", "capability_profile_versions", "job_deployment_binding_versions", "protect_job_registry_row", "registry_json_is_safe", "m9_version_at_least", "validate_job_deployment_binding", "assessment_receipt_seals", "successful shadow evidence", "0006_job_registry"]) required(migration, marker, "job-registry migration");
  if (/alter\s+table\s+agent_feed\.runs\s+add\s+column/iu.test(migration)) failures.push("M9 must not add job-registry fields to protocol run rows");

  const protocol = ["begin-run.schema.json", "submit-batch.schema.json", "complete-run.schema.json", "run-envelope.schema.json"].map((name) => read(`packages/schema/contracts/${name}`)).join("\n").toLowerCase();
  for (const forbidden of ["job_definition", "capability_profile", "off_switch", "shadow_assessment"]) if (protocol.includes(forbidden)) failures.push(`protocol 0.1 unexpectedly contains ${forbidden}`);
  const producer = [read("packages/producer-service/src/service.ts"), read("apps/api/src/index.ts"), read("apps/mcp-server/src/tools.ts")].join("\n");
  for (const forbidden of ["createJobDefinition", "createCapabilityProfile", "createDeploymentBinding", "activateJob"]) if (producer.includes(forbidden)) failures.push(`producer surface unexpectedly exposes ${forbidden}`);

  const workflow = read(".github/workflows/ci.yml");
  const coreInstalls = [...workflow.matchAll(/npm --prefix packages\/job-registry-core ci/gu)].map((match) => match.index);
  const persistenceInstalls = [...workflow.matchAll(/npm --prefix packages\/persistence-postgres ci/gu)].map((match) => match.index);
  if (coreInstalls.length !== persistenceInstalls.length || persistenceInstalls.some((position, index) => coreInstalls[index] === undefined || coreInstalls[index] > position)) failures.push("every clean persistence install must first install job-registry-core");
  for (const marker of ["milestone-9-job-registry", "npm run m9:conformance"]) required(workflow, marker, "CI workflow");
  const milestone = read("docs/21_milestone_9_job_registry.md");
  for (const marker of ["Protocol `0.1` remains immutable", "one logical job", "off-switch", "shadow evidence", "no secrets"]) required(milestone, marker, "M9 completion record");
  if (failures.length > 0) throw new Error(`M9 architecture failed:\n- ${failures.join("\n- ")}`);
  return 10;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`M9 job-registry architecture checks passed (${checkM9Architecture()} boundaries checked).`); }
  catch (error) { console.error(error instanceof Error ? error.message : "M9 architecture failed"); process.exitCode = 1; }
}
