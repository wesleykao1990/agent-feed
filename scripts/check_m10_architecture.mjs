import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

export function checkM10Architecture() {
  const failures = [];
  const required = (source, marker, label) => { if (!source.includes(marker)) failures.push(`${label} missing ${marker}`); };
  const corePackage = JSON.parse(read("packages/control-plane-core/package.json"));
  const postgresPackage = JSON.parse(read("packages/control-plane-postgres/package.json"));
  if (corePackage.name !== "@agent-feed/control-plane-core" || corePackage.version !== "0.1.1") failures.push("control-plane-core identity must be frozen at 0.1.1");
  if (postgresPackage.name !== "@agent-feed/control-plane-postgres" || postgresPackage.version !== "0.1.1") failures.push("control-plane-postgres identity must be frozen at 0.1.1");
  if (postgresPackage.dependencies?.["@agent-feed/control-plane-core"] !== "file:../control-plane-core") failures.push("PostgreSQL adapter must consume the exact local control-plane-core contract");

  const core = [read("packages/control-plane-core/src/types.ts"), read("packages/control-plane-core/src/normalize.ts")].join("\n");
  for (const marker of ["ControlPlaneObservationWindow", "completed_zero", "FAILURE_LAYERS", "unknown_field", "total_does_not_reconcile"]) required(core, marker, "control-plane core");

  const repository = read("packages/control-plane-postgres/src/repository.ts");
  const queries = read("packages/control-plane-postgres/src/queries.ts");
  for (const marker of ["repeatable read read only", "tenant_id = $1", "assessment_receipt_seals", "completed_zero", "count(*)::text"]) required(`${repository}\n${queries}`, marker, "PostgreSQL read adapter");
  for (const forbidden of ["envelope", "payload", "metadata", "summary", "error_detail", "signature", "storage_ref", "instruction_reference", "off_switch_reference"]) {
    if (queries.toLowerCase().includes(forbidden)) failures.push(`PostgreSQL aggregate query unexpectedly selects or names ${forbidden}`);
  }
  if (/\b(insert|update|delete|merge|truncate)\b/iu.test(queries)) failures.push("control-plane query inventory must remain read-only");

  const protocol = ["begin-run.schema.json", "submit-batch.schema.json", "complete-run.schema.json", "run-envelope.schema.json"].map((name) => read(`packages/schema/contracts/${name}`)).join("\n").toLowerCase();
  for (const forbidden of ["control_plane", "observationwindow", "failurelayers"]) if (protocol.includes(forbidden)) failures.push(`protocol 0.1 unexpectedly contains ${forbidden}`);
  const producer = [read("packages/producer-service/src/service.ts"), read("apps/api/src/index.ts"), read("apps/mcp-server/src/tools.ts")].join("\n");
  for (const forbidden of ["getControlPlaneSnapshot", "queryControlPlane", "controlPlaneAdmin"]) if (producer.includes(forbidden)) failures.push(`producer surface unexpectedly exposes ${forbidden}`);

  const workflow = read(".github/workflows/ci.yml");
  for (const marker of ["milestone-10-control-plane", "npm run m10:conformance", "npm --prefix packages/control-plane-core ci", "npm --prefix packages/control-plane-postgres ci"]) required(workflow, marker, "CI workflow");
  const milestone = read("docs/22_milestone_10_production_control_plane.md");
  for (const marker of ["observation", "REPEATABLE READ", "READ ONLY", "No Rewards Optimizer"]) required(milestone, marker, "M10 record");
  if (failures.length > 0) throw new Error(`M10 architecture failed:\n- ${failures.join("\n- ")}`);
  return 13;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`M10 control-plane architecture checks passed (${checkM10Architecture()} boundaries checked).`); }
  catch (error) { console.error(error instanceof Error ? error.message : "M10 architecture failed"); process.exitCode = 1; }
}
