export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export const JOB_DEFINITION_SCHEMA_VERSION = "agent-feed.job-definition.v1" as const;
export const CAPABILITY_PROFILE_SCHEMA_VERSION = "agent-feed.capability-profile.v1" as const;
export const DEPLOYMENT_BINDING_SCHEMA_VERSION = "agent-feed.deployment-binding.v1" as const;

export type JobLifecycleState = "draft" | "shadow" | "active" | "paused" | "retired";
export type DeploymentActivationState = "shadow" | "active" | "disabled";
export type TopologyRole = "scheduler" | "executor" | "ingress";
export type IngressKind = "rest" | "mcp" | "webhook" | "local_file" | "manual_export";

export interface InstructionReference {
  readonly digest: string;
  readonly controlledReference: string | null;
}

export interface CapabilityRequirement {
  readonly key: string;
  readonly minimumVersion: string | null;
  readonly role: TopologyRole;
}

export interface OutputContractReference {
  readonly contractKey: string;
  readonly version: string;
  readonly sha256: string;
}

export interface DeclaredJobBudget {
  readonly budgetKey: string;
  readonly limit: number;
  readonly unit: string;
}

export interface JobDefinitionInput {
  readonly schemaVersion?: string;
  readonly jobKey: string;
  readonly version: number;
  readonly ownerId: string;
  readonly lifecycleState: JobLifecycleState;
  readonly instructions: InstructionReference;
  readonly validationPolicyVersionId: string | null;
  readonly requiredCapabilities?: readonly CapabilityRequirement[];
  readonly outputContracts?: readonly OutputContractReference[];
  readonly budgets?: readonly DeclaredJobBudget[];
  readonly metadata?: JsonObject;
}

export interface JobDefinition {
  readonly schemaVersion: typeof JOB_DEFINITION_SCHEMA_VERSION;
  readonly jobKey: string;
  readonly version: number;
  readonly ownerId: string;
  readonly lifecycleState: JobLifecycleState;
  readonly instructions: InstructionReference;
  readonly validationPolicyVersionId: string | null;
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly outputContracts: readonly OutputContractReference[];
  readonly budgets: readonly DeclaredJobBudget[];
  readonly metadata: JsonObject;
}

export interface CapabilityOffering {
  readonly key: string;
  readonly version: string;
  readonly role: TopologyRole;
  readonly available: boolean;
}

export interface CapabilityProfileInput {
  readonly schemaVersion?: string;
  readonly profileKey: string;
  readonly version: number;
  readonly providerKey: string;
  readonly capabilities?: readonly CapabilityOffering[];
  readonly metadata?: JsonObject;
}

export interface CapabilityProfile {
  readonly schemaVersion: typeof CAPABILITY_PROFILE_SCHEMA_VERSION;
  readonly profileKey: string;
  readonly version: number;
  readonly providerKey: string;
  readonly capabilities: readonly CapabilityOffering[];
  readonly metadata: JsonObject;
}

export interface DeploymentTopology {
  readonly schedulerProvider: string;
  readonly executorProvider: string;
  readonly ingressKind: IngressKind;
}

export interface ShadowEvidence {
  readonly assessmentId: string;
  readonly verdict: "passed";
  readonly independence: "independent";
}

export interface DeploymentBindingInput {
  readonly schemaVersion?: string;
  readonly bindingKey: string;
  readonly version: number;
  readonly jobDefinitionId: string;
  readonly activationState: DeploymentActivationState;
  readonly topology: DeploymentTopology;
  readonly capabilityProfiles: readonly CapabilityProfileInput[];
  readonly offSwitchReference: string | null;
  readonly shadowEvidence?: readonly ShadowEvidence[];
  readonly metadata?: JsonObject;
}

export interface DeploymentBinding extends Omit<DeploymentBindingInput, "schemaVersion" | "capabilityProfiles" | "shadowEvidence" | "metadata"> {
  readonly schemaVersion: typeof DEPLOYMENT_BINDING_SCHEMA_VERSION;
  readonly capabilityProfiles: readonly CapabilityProfile[];
  readonly shadowEvidence: readonly ShadowEvidence[];
  readonly metadata: JsonObject;
}

export type PreflightReason =
  | "compatible"
  | "missing_owner"
  | "missing_validation_policy"
  | "missing_budget"
  | "missing_off_switch"
  | "missing_shadow_evidence"
  | "missing_capability"
  | "incompatible_capability";

export interface CapabilityGap {
  readonly key: string;
  readonly role: TopologyRole;
  readonly requiredVersion: string | null;
  readonly offeredVersion: string | null;
  readonly reason: "missing" | "version";
}

export interface ActivationPreflight {
  readonly compatible: boolean;
  readonly reasons: readonly PreflightReason[];
  readonly capabilityGaps: readonly CapabilityGap[];
  readonly jobDefinitionHash: string;
  readonly capabilityProfileHashes: readonly string[];
}

export class JobRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`job_registry_invalid:${issues.join(";")}`);
    this.name = "JobRegistryError";
    this.issues = issues;
  }
}
