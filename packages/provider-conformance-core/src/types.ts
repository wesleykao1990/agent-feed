import type { TelemetryState, UsageMetric, UsageProvenanceType } from "@agent-feed/assessment-core";
import type { IngressKind } from "@agent-feed/job-registry-core";

export const PROVIDER_CONFORMANCE_RECEIPT_VERSION = "agent-feed.provider-conformance.v1" as const;
export const PROVIDER_CONFORMANCE_MATRIX_VERSION = "agent-feed.provider-conformance-matrix.v1" as const;

export type OccurrenceProofState = "satisfied" | "absent" | "unknown";
export type ExecutionProofState = "running" | "completed" | "partial" | "failed" | "cancelled" | "unknown";
export type AssessmentProofState = "passed" | "failed" | "inconclusive" | "unknown";
export type DeliveryProofState = "queued" | "leased" | "retry" | "acknowledged" | "dead_letter" | "unknown";

export interface ConformanceLogicalJob {
  readonly jobKey: string;
  readonly definitionVersion: number;
  readonly jobDefinitionHash: string;
  readonly validationPolicyVersionId: string;
}

export interface ConformanceTopology {
  readonly schedulerProvider: string;
  readonly executorProvider: string;
  readonly ingressKind: IngressKind;
  readonly deploymentBindingHash: string;
  readonly capabilityProfileHashes: readonly string[];
}

export interface ConformanceExecutionContext {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly externalInvocationDigest: string | null;
}

export interface ConformanceProofs {
  readonly occurrence: OccurrenceProofState;
  readonly execution: ExecutionProofState;
  readonly assessment: AssessmentProofState;
  readonly delivery: DeliveryProofState;
}

export interface ConformanceTelemetryObservation {
  readonly metric: UsageMetric;
  readonly state: TelemetryState;
  readonly value: number | null;
  readonly provenance: UsageProvenanceType;
}

export interface ProviderConformanceReceiptInput {
  readonly schemaVersion?: string;
  readonly receiptKey: string;
  readonly logicalJob: ConformanceLogicalJob;
  readonly topology: ConformanceTopology;
  readonly executionContext: ConformanceExecutionContext;
  readonly proofs: ConformanceProofs;
  readonly telemetry: readonly ConformanceTelemetryObservation[];
}

export interface ProviderConformanceReceipt extends Omit<ProviderConformanceReceiptInput, "schemaVersion"> {
  readonly schemaVersion: typeof PROVIDER_CONFORMANCE_RECEIPT_VERSION;
}

export interface TelemetryCoverage {
  readonly observed: number;
  readonly unknown: number;
  readonly notApplicable: number;
}

export interface ProviderConformanceMatrix {
  readonly schemaVersion: typeof PROVIDER_CONFORMANCE_MATRIX_VERSION;
  readonly logicalJob: ConformanceLogicalJob;
  readonly topologyCount: number;
  readonly receipts: readonly ProviderConformanceReceipt[];
  readonly telemetryCoverage: Readonly<Record<UsageMetric, TelemetryCoverage>>;
}

export class ProviderConformanceError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`provider_conformance_invalid:${issues.join(";")}`);
    this.name = "ProviderConformanceError";
    this.issues = issues;
  }
}
