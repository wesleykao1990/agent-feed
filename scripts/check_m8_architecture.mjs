import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

export function checkM8Texts(input) {
  const failures = [];
  const requireText = (source, marker, label) => {
    if (!source.includes(marker)) failures.push(`${label} missing ${marker}`);
  };

  if (input.corePackage.name !== "@agent-feed/assessment-core" || input.corePackage.version !== "0.1.1") {
    failures.push("assessment-core must publish the frozen @agent-feed/assessment-core@0.1.1 contract");
  }
  if (input.persistencePackage.dependencies?.["@agent-feed/assessment-core"] !== "file:../assessment-core") {
    failures.push("persistence must consume the local assessment-core contract");
  }

  for (const marker of [
    "producer_self_check", "independent_agent", "human_reviewer", "validation_service",
    "technical", "quality", "security", "compliance", "operational",
    "observed", "unknown", "not_applicable", "UsageProvenanceType",
    "DeclaredBudgetState", "ArtifactReferenceInput",
  ]) requireText(input.coreTypes, marker, "assessment-core types");
  for (const marker of [
    "ASSESSMENT_FIELDS", "validateAssessment", "normalizeAssessment", "validateAssessorAuthority",
    "technicalcompletion", "assessoridentity", "normalizeArtifact", "normalizeUsage",
  ]) requireText(input.coreValidation, marker, "assessment-core validation");
  for (const marker of ["canonicalAssessmentRequest", "hashAssessmentRequest"]) {
    requireText(input.coreRequest, marker, "assessment request hashing");
  }

  for (const marker of [
    "validation_policy_versions", "trusted_assessor_registration_versions", "run_assessments",
    "assessment_declared_budgets", "assessment_usage_observations", "assessment_artifact_references",
    "assessment_receipt_seals", "reject_assessment_child_after_seal", "validate_assessment_receipt_seal_presence",
    "validate_artifact_safety", "9007199254740991",
    "protect_job_proof_row", "validate_job_proof_policy", "validate_trusted_assessor_registration",
    "validate_run_assessment", "policy_canonical_json", "0005_job_proof",
  ]) requireText(input.migration, marker, "job-proof migration");
  for (const marker of [
    "submitAssessment", "assertSubmissionHasNoAuthorityFields", "wire_run_id", "for update",
    "assessor_not_independent", "assessment_conflict", "reassessment_of", "assessment_receipt_seals",
  ]) requireText(input.store, marker, "PostgreSQL assessment repository");
  for (const marker of [
    "late-budget", "late-usage", "late-artifact", "fractional-usage",
    "credential-artifact", "m8-unsealed", "assessment_receipt_seals",
  ]) requireText(input.persistenceTest, marker, "job-proof hostile regression");
  if (/alter\s+table\s+agent_feed\.runs\s+add\s+column/iu.test(input.migration)) {
    failures.push("M8 migration must not add assessment fields to protocol run rows");
  }

  for (const forbidden of ["assessor_type", "assessor_independence", "failure_stage", "stop_reason", "usage_provenance"]) {
    if (input.protocolSchemas.toLowerCase().includes(forbidden)) {
      failures.push(`protocol 0.1 schemas unexpectedly contain ${forbidden}`);
    }
  }
  for (const forbidden of ["submitAssessment", "registerTrustedAssessor", "validation_policy"]) {
    if (input.producerSurfaces.includes(forbidden)) {
      failures.push(`producer REST/MCP surface unexpectedly exposes ${forbidden}`);
    }
  }

  const assessmentInstalls = [...input.workflow.matchAll(/npm --prefix packages\/assessment-core ci/gu)].map((match) => match.index);
  const persistenceInstalls = [...input.workflow.matchAll(/npm --prefix packages\/persistence-postgres ci/gu)].map((match) => match.index);
  if (assessmentInstalls.length !== persistenceInstalls.length
    || persistenceInstalls.some((position, index) => assessmentInstalls[index] === undefined || assessmentInstalls[index] > position)) {
    failures.push("every CI job that installs persistence must first install assessment-core");
  }
  for (const marker of [
    "packages/assessment-core ci", "packages/persistence-postgres ci", "npm run m8:conformance",
  ]) requireText(input.workflow, marker, "CI workflow");
  for (const marker of [
    'packages/assessment-core", "run", "build', 'packages/assessment-core", "test',
    'packages/persistence-postgres", "run", "build', 'packages/persistence-postgres", "test',
    "AGENT_FEED_DATABASE_URL", "protocol compatibility",
  ]) requireText(input.runner, marker, "M8 runner");
  for (const marker of [
    "Protocol `0.1` remains immutable", "producer self-check", "unknown telemetry", "rather than blobs",
  ]) requireText(input.milestone, marker, "M8 completion record");

  return failures;
}

export function checkM8Architecture() {
  const schemaFiles = [
    "begin-run.schema.json", "complete-run.schema.json", "delivery-event.schema.json",
    "evidence.schema.json", "finding.schema.json", "run-envelope.schema.json",
    "run-bundle.schema.json", "stream-expectation.schema.json", "submit-batch.schema.json",
  ];
  const failures = checkM8Texts({
    corePackage: JSON.parse(read("packages/assessment-core/package.json")),
    persistencePackage: JSON.parse(read("packages/persistence-postgres/package.json")),
    coreTypes: read("packages/assessment-core/src/types.ts"),
    coreValidation: read("packages/assessment-core/src/validation.ts"),
    coreRequest: read("packages/assessment-core/src/request.ts"),
    migration: read("packages/persistence-postgres/migrations/0005_job_proof.sql"),
    store: read("packages/persistence-postgres/src/assessment-store.ts"),
    persistenceTest: read("packages/persistence-postgres/test/assessment.test.ts"),
    protocolSchemas: schemaFiles.map((name) => read(`packages/schema/contracts/${name}`)).join("\n"),
    producerSurfaces: [
      read("packages/producer-service/src/service.ts"), read("apps/api/src/index.ts"),
      read("apps/mcp-server/src/tools.ts"), read("apps/mcp-server/src/lifecycle.ts"),
    ].join("\n"),
    workflow: read(".github/workflows/ci.yml"),
    runner: read("scripts/run_m8_conformance.mjs"),
    milestone: read("docs/20_milestone_8_job_proof.md"),
  });
  if (failures.length > 0) throw new Error(`M8 job-proof architecture failed:\n- ${failures.join("\n- ")}`);
  return 10;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = checkM8Architecture();
    console.log(`M8 job-proof architecture checks passed (${count} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M8 job-proof architecture failed");
    process.exitCode = 1;
  }
}
