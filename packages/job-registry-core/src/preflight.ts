import { canonicalJson, sha256Hex } from "./canonical.ts";
import { normalizeCapabilityProfile, normalizeDeploymentBinding, normalizeJobDefinition } from "./validation.ts";
import type {
  ActivationPreflight,
  CapabilityGap,
  CapabilityProfile,
  CapabilityProfileInput,
  DeploymentBindingInput,
  JobDefinitionInput,
  JsonValue,
  PreflightReason,
} from "./types.ts";

function versionParts(value: string): number[] { return value.split(".").map(Number); }
function versionAtLeast(offered: string, required: string): boolean {
  const left = versionParts(offered);
  const right = versionParts(required);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function hashJobDefinition(input: JobDefinitionInput): string {
  return sha256Hex(canonicalJson(normalizeJobDefinition(input) as unknown as JsonValue));
}

export function hashCapabilityProfile(input: CapabilityProfileInput): string {
  return sha256Hex(canonicalJson(normalizeCapabilityProfile(input) as unknown as JsonValue));
}

export function evaluateActivationPreflight(jobInput: JobDefinitionInput, bindingInput: DeploymentBindingInput): ActivationPreflight {
  const job = normalizeJobDefinition(jobInput);
  const binding = normalizeDeploymentBinding(bindingInput);
  if (binding.jobDefinitionId !== job.jobKey && binding.jobDefinitionId !== `${job.jobKey}:${job.version}`) {
    throw new Error("job_definition_binding_mismatch");
  }
  const offerings = new Map<string, CapabilityProfile["capabilities"][number]>();
  for (const profile of binding.capabilityProfiles) {
    for (const item of profile.capabilities) if (item.available) offerings.set(`${item.role}:${item.key}`, item);
  }
  const capabilityGaps: CapabilityGap[] = [];
  for (const required of job.requiredCapabilities) {
    const offered = offerings.get(`${required.role}:${required.key}`);
    if (!offered) capabilityGaps.push({ key: required.key, role: required.role, requiredVersion: required.minimumVersion, offeredVersion: null, reason: "missing" });
    else if (required.minimumVersion !== null && !versionAtLeast(offered.version, required.minimumVersion)) {
      capabilityGaps.push({ key: required.key, role: required.role, requiredVersion: required.minimumVersion, offeredVersion: offered.version, reason: "version" });
    }
  }
  const reasons = new Set<PreflightReason>();
  if (job.ownerId.length === 0) reasons.add("missing_owner");
  if (capabilityGaps.some((gap) => gap.reason === "missing")) reasons.add("missing_capability");
  if (capabilityGaps.some((gap) => gap.reason === "version")) reasons.add("incompatible_capability");
  if (binding.activationState === "active") {
    if (job.validationPolicyVersionId === null) reasons.add("missing_validation_policy");
    if (job.budgets.length === 0) reasons.add("missing_budget");
    if (binding.offSwitchReference === null) reasons.add("missing_off_switch");
    if (binding.shadowEvidence.length === 0) reasons.add("missing_shadow_evidence");
  }
  if (reasons.size === 0) reasons.add("compatible");
  return {
    compatible: reasons.size === 1 && reasons.has("compatible"),
    reasons: [...reasons].sort(),
    capabilityGaps,
    jobDefinitionHash: hashJobDefinition(job),
    capabilityProfileHashes: binding.capabilityProfiles.map(hashCapabilityProfile).sort(),
  };
}
