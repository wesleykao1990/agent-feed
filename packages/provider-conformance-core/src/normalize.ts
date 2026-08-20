import {
  TELEMETRY_STATES,
  USAGE_METRICS,
  USAGE_PROVENANCE_TYPES,
  type TelemetryState,
  type UsageMetric,
  type UsageProvenanceType,
} from "@agent-feed/assessment-core";
import type { IngressKind } from "@agent-feed/job-registry-core";
import {
  PROVIDER_CONFORMANCE_RECEIPT_VERSION,
  ProviderConformanceError,
  type AssessmentProofState,
  type ConformanceExecutionContext,
  type ConformanceLogicalJob,
  type ConformanceProofs,
  type ConformanceTelemetryObservation,
  type ConformanceTopology,
  type DeliveryProofState,
  type ExecutionProofState,
  type OccurrenceProofState,
  type ProviderConformanceReceipt,
  type ProviderConformanceReceiptInput,
} from "./types.ts";

const TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INGRESS = ["rest", "mcp", "webhook", "local_file", "manual_export"] as const;
const OCCURRENCE = ["satisfied", "absent", "unknown"] as const;
const EXECUTION = ["running", "completed", "partial", "failed", "cancelled", "unknown"] as const;
const ASSESSMENT = ["passed", "failed", "inconclusive", "unknown"] as const;
const DELIVERY = ["queued", "leased", "retry", "acknowledged", "dead_letter", "unknown"] as const;

function object(value: unknown, path: string, fields: readonly string[], issues: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    issues.push(`${path}:plain_object_required`);
    return {};
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!fields.includes(key)) issues.push(`${path}.${key}:unknown_field`);
  return record;
}

function text(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || !TEXT.test(value)) { issues.push(`${path}:invalid_text`); return "invalid"; }
  return value;
}

function hash(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || !SHA256.test(value)) { issues.push(`${path}:lowercase_sha256_required`); return "0".repeat(64); }
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string, issues: string[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) { issues.push(`${path}:unsupported`); return values[0]!; }
  return value as T;
}

function logicalJob(value: unknown, issues: string[]): ConformanceLogicalJob {
  const record = object(value, "logicalJob", ["jobKey", "definitionVersion", "jobDefinitionHash", "validationPolicyVersionId"], issues);
  if (!Number.isSafeInteger(record.definitionVersion) || (record.definitionVersion as number) < 1) issues.push("logicalJob.definitionVersion:positive_safe_integer_required");
  return {
    jobKey: text(record.jobKey, "logicalJob.jobKey", issues),
    definitionVersion: Number.isSafeInteger(record.definitionVersion) ? record.definitionVersion as number : 1,
    jobDefinitionHash: hash(record.jobDefinitionHash, "logicalJob.jobDefinitionHash", issues),
    validationPolicyVersionId: text(record.validationPolicyVersionId, "logicalJob.validationPolicyVersionId", issues),
  };
}

function topology(value: unknown, issues: string[]): ConformanceTopology {
  const record = object(value, "topology", ["schedulerProvider", "executorProvider", "ingressKind", "deploymentBindingHash", "capabilityProfileHashes"], issues);
  const profiles = Array.isArray(record.capabilityProfileHashes) ? record.capabilityProfileHashes : [];
  if (!Array.isArray(record.capabilityProfileHashes) || profiles.length < 1 || profiles.length > 32) issues.push("topology.capabilityProfileHashes:bounded_nonempty_array_required");
  const normalizedProfiles = profiles.map((item, index) => hash(item, `topology.capabilityProfileHashes[${index}]`, issues)).sort();
  if (new Set(normalizedProfiles).size !== normalizedProfiles.length) issues.push("topology.capabilityProfileHashes:duplicate");
  return {
    schedulerProvider: text(record.schedulerProvider, "topology.schedulerProvider", issues),
    executorProvider: text(record.executorProvider, "topology.executorProvider", issues),
    ingressKind: enumeration<IngressKind>(record.ingressKind, INGRESS, "topology.ingressKind", issues),
    deploymentBindingHash: hash(record.deploymentBindingHash, "topology.deploymentBindingHash", issues),
    capabilityProfileHashes: normalizedProfiles,
  };
}

function executionContext(value: unknown, issues: string[]): ConformanceExecutionContext {
  const record = object(value, "executionContext", ["adapterKey", "adapterVersion", "externalInvocationDigest"], issues);
  const adapterVersion = typeof record.adapterVersion === "string" ? record.adapterVersion : "";
  if (!VERSION.test(adapterVersion)) issues.push("executionContext.adapterVersion:invalid_version");
  return {
    adapterKey: text(record.adapterKey, "executionContext.adapterKey", issues),
    adapterVersion,
    externalInvocationDigest: record.externalInvocationDigest === null ? null : hash(record.externalInvocationDigest, "executionContext.externalInvocationDigest", issues),
  };
}

function proofs(value: unknown, issues: string[]): ConformanceProofs {
  const record = object(value, "proofs", ["occurrence", "execution", "assessment", "delivery"], issues);
  return {
    occurrence: enumeration<OccurrenceProofState>(record.occurrence, OCCURRENCE, "proofs.occurrence", issues),
    execution: enumeration<ExecutionProofState>(record.execution, EXECUTION, "proofs.execution", issues),
    assessment: enumeration<AssessmentProofState>(record.assessment, ASSESSMENT, "proofs.assessment", issues),
    delivery: enumeration<DeliveryProofState>(record.delivery, DELIVERY, "proofs.delivery", issues),
  };
}

function telemetry(value: unknown, issues: string[]): ConformanceTelemetryObservation[] {
  if (!Array.isArray(value) || value.length !== USAGE_METRICS.length) {
    issues.push("telemetry:exact_metric_inventory_required");
    return [];
  }
  const seen = new Set<UsageMetric>();
  const result: ConformanceTelemetryObservation[] = [];
  for (const [index, item] of value.entries()) {
    const record = object(item, `telemetry[${index}]`, ["metric", "state", "value", "provenance"], issues);
    const metric = enumeration<UsageMetric>(record.metric, USAGE_METRICS, `telemetry[${index}].metric`, issues);
    const state = enumeration<TelemetryState>(record.state, TELEMETRY_STATES, `telemetry[${index}].state`, issues);
    const provenance = enumeration<UsageProvenanceType>(record.provenance, USAGE_PROVENANCE_TYPES, `telemetry[${index}].provenance`, issues);
    if (seen.has(metric)) issues.push(`telemetry[${index}].metric:duplicate`);
    seen.add(metric);
    const observed = state === "observed";
    if (observed && (!Number.isSafeInteger(record.value) || (record.value as number) < 0)) issues.push(`telemetry[${index}].value:observed_safe_integer_required`);
    if (!observed && record.value !== null) issues.push(`telemetry[${index}].value:null_required`);
    if (observed && provenance === "unknown") issues.push(`telemetry[${index}].provenance:known_required`);
    if (state === "unknown" && provenance !== "unknown") issues.push(`telemetry[${index}].provenance:unknown_required`);
    result.push({ metric, state, value: observed && Number.isSafeInteger(record.value) ? record.value as number : null, provenance });
  }
  for (const metric of USAGE_METRICS) if (!seen.has(metric)) issues.push(`telemetry.${metric}:missing`);
  return result.sort((left, right) => left.metric.localeCompare(right.metric));
}

export function normalizeProviderConformanceReceipt(input: ProviderConformanceReceiptInput): ProviderConformanceReceipt {
  const issues: string[] = [];
  const root = object(input, "root", ["schemaVersion", "receiptKey", "logicalJob", "topology", "executionContext", "proofs", "telemetry"], issues);
  if (root.schemaVersion !== undefined && root.schemaVersion !== PROVIDER_CONFORMANCE_RECEIPT_VERSION) issues.push("schemaVersion:unsupported");
  const result: ProviderConformanceReceipt = {
    schemaVersion: PROVIDER_CONFORMANCE_RECEIPT_VERSION,
    receiptKey: text(root.receiptKey, "receiptKey", issues),
    logicalJob: logicalJob(root.logicalJob, issues),
    topology: topology(root.topology, issues),
    executionContext: executionContext(root.executionContext, issues),
    proofs: proofs(root.proofs, issues),
    telemetry: telemetry(root.telemetry, issues),
  };
  if (issues.length > 0) throw new ProviderConformanceError(issues);
  return Object.freeze({
    ...result,
    logicalJob: Object.freeze(result.logicalJob),
    topology: Object.freeze({
      ...result.topology,
      capabilityProfileHashes: Object.freeze([...result.topology.capabilityProfileHashes]),
    }),
    executionContext: Object.freeze(result.executionContext),
    proofs: Object.freeze(result.proofs),
    telemetry: Object.freeze(result.telemetry.map((observation) => Object.freeze(observation))),
  });
}
