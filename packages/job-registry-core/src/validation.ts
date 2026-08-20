import {
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  DEPLOYMENT_BINDING_SCHEMA_VERSION,
  JOB_DEFINITION_SCHEMA_VERSION,
  JobRegistryError,
  type CapabilityOffering,
  type CapabilityProfile,
  type CapabilityProfileInput,
  type CapabilityRequirement,
  type DeclaredJobBudget,
  type DeploymentBinding,
  type DeploymentBindingInput,
  type JobDefinition,
  type JobDefinitionInput,
  type JsonObject,
  type JsonValue,
  type OutputContractReference,
} from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const REFERENCE = /^(?:config|vault-ref|git\+https|object):\/\/[A-Za-z0-9._~:/@+-]+$/u;
const SENSITIVE_KEYS = /(?:authorization|credential|password|secret|token|private.?key|api.?key|access.?key|signed.?url|signature|inline|blob|base64|payload|content|body)/iu;
const CREDENTIAL_VALUES = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)/iu;
const LIFECYCLE = new Set(["draft", "shadow", "active", "paused", "retired"]);
const ACTIVATION = new Set(["shadow", "active", "disabled"]);
const ROLES = new Set(["scheduler", "executor", "ingress"]);
const INGRESS = new Set(["rest", "mcp", "webhook", "local_file", "manual_export"]);

function text(value: unknown, path: string, issues: string[], max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL.test(value)) {
    issues.push(`${path}:invalid_text`);
    return "";
  }
  return value.trim();
}

function positiveVersion(value: unknown, path: string, issues: string[]): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) issues.push(`${path}:positive_safe_integer_required`);
  return Number.isSafeInteger(value) ? value as number : 0;
}

function safeJson(value: unknown, path: string, issues: string[], depth = 0): JsonValue {
  if (depth > 6) { issues.push(`${path}:depth_limit`); return null; }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) issues.push(`${path}:safe_integer_required`);
    return Number.isSafeInteger(value) ? value : 0;
  }
  if (typeof value === "string") {
    if (value.length > 4096 || CONTROL.test(value) || CREDENTIAL_VALUES.test(value) || /^data:/iu.test(value)) issues.push(`${path}:unsafe_value`);
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((entry, index) => safeJson(entry, `${path}[${index}]`, issues, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) { issues.push(`${path}:plain_json_required`); return null; }
  const result: Record<string, JsonValue> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) issues.push(`${path}:key_limit`);
  for (const [key, entry] of entries.slice(0, 64)) {
    if (SENSITIVE_KEYS.test(key)) issues.push(`${path}.${key}:sensitive_key`);
    result[key] = safeJson(entry, `${path}.${key}`, issues, depth + 1);
  }
  return result;
}

function reference(value: unknown, path: string, issues: string[], nullable = false): string | null {
  if (nullable && value === null) return null;
  const normalized = text(value, path, issues, 1024);
  if (!REFERENCE.test(normalized) || normalized.includes("?") || normalized.includes("#") || CREDENTIAL_VALUES.test(normalized)) issues.push(`${path}:controlled_reference_required`);
  return normalized;
}

function requirement(value: CapabilityRequirement, index: number, issues: string[]): CapabilityRequirement {
  const role = value?.role;
  if (!ROLES.has(role)) issues.push(`requiredCapabilities[${index}].role:invalid`);
  const minimumVersion = value?.minimumVersion === null ? null : text(value?.minimumVersion, `requiredCapabilities[${index}].minimumVersion`, issues, 32);
  if (minimumVersion !== null && !VERSION.test(minimumVersion)) issues.push(`requiredCapabilities[${index}].minimumVersion:invalid_version`);
  return { key: text(value?.key, `requiredCapabilities[${index}].key`, issues), minimumVersion, role };
}

function output(value: OutputContractReference, index: number, issues: string[]): OutputContractReference {
  const sha256 = text(value?.sha256, `outputContracts[${index}].sha256`, issues, 64);
  if (!SHA256.test(sha256)) issues.push(`outputContracts[${index}].sha256:lowercase_sha256_required`);
  return { contractKey: text(value?.contractKey, `outputContracts[${index}].contractKey`, issues), version: text(value?.version, `outputContracts[${index}].version`, issues), sha256 };
}

function budget(value: DeclaredJobBudget, index: number, issues: string[]): DeclaredJobBudget {
  if (!Number.isSafeInteger(value?.limit) || value.limit < 0) issues.push(`budgets[${index}].limit:nonnegative_safe_integer_required`);
  return { budgetKey: text(value?.budgetKey, `budgets[${index}].budgetKey`, issues), limit: value?.limit ?? 0, unit: text(value?.unit, `budgets[${index}].unit`, issues) };
}

function uniqueKeys(values: readonly { key?: string; contractKey?: string; budgetKey?: string; role?: string }[], path: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.role ?? ""}:${value.key ?? value.contractKey ?? value.budgetKey ?? ""}`;
    if (seen.has(key)) issues.push(`${path}:duplicate_key:${key}`);
    seen.add(key);
  }
}

export function normalizeJobDefinition(input: JobDefinitionInput): JobDefinition {
  const issues: string[] = [];
  if (input.schemaVersion !== undefined && input.schemaVersion !== JOB_DEFINITION_SCHEMA_VERSION) issues.push("schemaVersion:unsupported");
  if (!LIFECYCLE.has(input.lifecycleState)) issues.push("lifecycleState:invalid");
  const digest = text(input.instructions?.digest, "instructions.digest", issues, 64);
  if (!SHA256.test(digest)) issues.push("instructions.digest:lowercase_sha256_required");
  const requiredCapabilities = (input.requiredCapabilities ?? []).map((value, index) => requirement(value, index, issues)).sort((a, b) => `${a.role}:${a.key}`.localeCompare(`${b.role}:${b.key}`));
  const outputContracts = (input.outputContracts ?? []).map((value, index) => output(value, index, issues)).sort((a, b) => a.contractKey.localeCompare(b.contractKey));
  const budgets = (input.budgets ?? []).map((value, index) => budget(value, index, issues)).sort((a, b) => a.budgetKey.localeCompare(b.budgetKey));
  uniqueKeys(requiredCapabilities, "requiredCapabilities", issues);
  uniqueKeys(outputContracts, "outputContracts", issues);
  uniqueKeys(budgets, "budgets", issues);
  const result: JobDefinition = {
    schemaVersion: JOB_DEFINITION_SCHEMA_VERSION,
    jobKey: text(input.jobKey, "jobKey", issues),
    version: positiveVersion(input.version, "version", issues),
    ownerId: text(input.ownerId, "ownerId", issues),
    lifecycleState: input.lifecycleState,
    instructions: { digest, controlledReference: reference(input.instructions?.controlledReference, "instructions.controlledReference", issues, true) },
    validationPolicyVersionId: input.validationPolicyVersionId === null ? null : text(input.validationPolicyVersionId, "validationPolicyVersionId", issues),
    requiredCapabilities,
    outputContracts,
    budgets,
    metadata: safeJson(input.metadata ?? {}, "metadata", issues) as JsonObject,
  };
  if (issues.length > 0) throw new JobRegistryError(issues);
  return result;
}

function offering(value: CapabilityOffering, index: number, issues: string[]): CapabilityOffering {
  if (!ROLES.has(value?.role)) issues.push(`capabilities[${index}].role:invalid`);
  const version = text(value?.version, `capabilities[${index}].version`, issues, 32);
  if (!VERSION.test(version)) issues.push(`capabilities[${index}].version:invalid_version`);
  if (typeof value?.available !== "boolean") issues.push(`capabilities[${index}].available:boolean_required`);
  return { key: text(value?.key, `capabilities[${index}].key`, issues), version, role: value?.role, available: value?.available === true };
}

export function normalizeCapabilityProfile(input: CapabilityProfileInput): CapabilityProfile {
  const issues: string[] = [];
  if (input.schemaVersion !== undefined && input.schemaVersion !== CAPABILITY_PROFILE_SCHEMA_VERSION) issues.push("schemaVersion:unsupported");
  const capabilities = (input.capabilities ?? []).map((value, index) => offering(value, index, issues)).sort((a, b) => `${a.role}:${a.key}`.localeCompare(`${b.role}:${b.key}`));
  uniqueKeys(capabilities, "capabilities", issues);
  const result: CapabilityProfile = {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    profileKey: text(input.profileKey, "profileKey", issues),
    version: positiveVersion(input.version, "version", issues),
    providerKey: text(input.providerKey, "providerKey", issues),
    capabilities,
    metadata: safeJson(input.metadata ?? {}, "metadata", issues) as JsonObject,
  };
  if (issues.length > 0) throw new JobRegistryError(issues);
  return result;
}

export function normalizeDeploymentBinding(input: DeploymentBindingInput): DeploymentBinding {
  const issues: string[] = [];
  if (input.schemaVersion !== undefined && input.schemaVersion !== DEPLOYMENT_BINDING_SCHEMA_VERSION) issues.push("schemaVersion:unsupported");
  if (!ACTIVATION.has(input.activationState)) issues.push("activationState:invalid");
  if (!INGRESS.has(input.topology?.ingressKind)) issues.push("topology.ingressKind:invalid");
  const shadowEvidence = [...(input.shadowEvidence ?? [])].sort((a, b) => a.assessmentId.localeCompare(b.assessmentId));
  if (new Set(shadowEvidence.map((item) => item.assessmentId)).size !== shadowEvidence.length) issues.push("shadowEvidence:duplicate_assessment");
  for (const [index, evidence] of shadowEvidence.entries()) {
    text(evidence.assessmentId, `shadowEvidence[${index}].assessmentId`, issues);
    if (evidence.verdict !== "passed" || evidence.independence !== "independent") issues.push(`shadowEvidence[${index}]:successful_independent_proof_required`);
  }
  const result: DeploymentBinding = {
    schemaVersion: DEPLOYMENT_BINDING_SCHEMA_VERSION,
    bindingKey: text(input.bindingKey, "bindingKey", issues),
    version: positiveVersion(input.version, "version", issues),
    jobDefinitionId: text(input.jobDefinitionId, "jobDefinitionId", issues),
    activationState: input.activationState,
    topology: {
      schedulerProvider: text(input.topology?.schedulerProvider, "topology.schedulerProvider", issues),
      executorProvider: text(input.topology?.executorProvider, "topology.executorProvider", issues),
      ingressKind: input.topology?.ingressKind,
    },
    capabilityProfiles: input.capabilityProfiles.map(normalizeCapabilityProfile).sort((a, b) => a.profileKey.localeCompare(b.profileKey)),
    offSwitchReference: reference(input.offSwitchReference, "offSwitchReference", issues, true),
    shadowEvidence,
    metadata: safeJson(input.metadata ?? {}, "metadata", issues) as JsonObject,
  };
  if (issues.length > 0) throw new JobRegistryError(issues);
  return result;
}
