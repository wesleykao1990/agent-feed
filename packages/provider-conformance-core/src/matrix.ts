import { USAGE_METRICS, type UsageMetric } from "@agent-feed/assessment-core";
import {
  PROVIDER_CONFORMANCE_MATRIX_VERSION,
  ProviderConformanceError,
  type ProviderConformanceMatrix,
  type ProviderConformanceReceipt,
  type ProviderConformanceReceiptInput,
  type TelemetryCoverage,
} from "./types.ts";
import { normalizeProviderConformanceReceipt } from "./normalize.ts";

function logicalIdentity(receipt: ProviderConformanceReceipt): string {
  const job = receipt.logicalJob;
  return JSON.stringify([job.jobKey, job.definitionVersion, job.jobDefinitionHash, job.validationPolicyVersionId]);
}

function topologyIdentity(receipt: ProviderConformanceReceipt): string {
  const topology = receipt.topology;
  return JSON.stringify([topology.schedulerProvider, topology.executorProvider, topology.ingressKind, topology.deploymentBindingHash]);
}

export function buildProviderConformanceMatrix(inputs: readonly ProviderConformanceReceiptInput[], minimumTopologies = 3): ProviderConformanceMatrix {
  const issues: string[] = [];
  if (!Number.isSafeInteger(minimumTopologies) || minimumTopologies < 3 || minimumTopologies > 32) issues.push("minimumTopologies:integer_between_3_and_32_required");
  if (!Array.isArray(inputs) || inputs.length < minimumTopologies || inputs.length > 32) issues.push("receipts:bounded_minimum_topologies_required");
  const receipts: ProviderConformanceReceipt[] = [];
  for (const [index, input] of inputs.entries()) {
    try { receipts.push(normalizeProviderConformanceReceipt(input)); }
    catch (error) {
      if (error instanceof ProviderConformanceError) issues.push(...error.issues.map((item) => `receipts[${index}].${item}`));
      else issues.push(`receipts[${index}]:invalid`);
    }
  }
  const logicalIdentities = new Set(receipts.map(logicalIdentity));
  if (logicalIdentities.size > 1) issues.push("receipts:logical_job_identity_mismatch");
  const topologies = new Set(receipts.map(topologyIdentity));
  if (topologies.size < minimumTopologies) issues.push("receipts:distinct_topology_minimum_not_met");
  if (new Set(receipts.map((receipt) => receipt.receiptKey)).size !== receipts.length) issues.push("receipts:duplicate_receipt_key");
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.proofs.occurrence === "unknown" || receipt.proofs.execution === "unknown" || receipt.proofs.assessment === "unknown" || receipt.proofs.delivery === "unknown") {
      issues.push(`receipts[${index}].proofs:complete_proof_layers_required`);
    }
    if (receipt.proofs.execution === "running" || receipt.proofs.delivery === "queued" || receipt.proofs.delivery === "leased" || receipt.proofs.delivery === "retry") {
      issues.push(`receipts[${index}].proofs:terminal_comparison_required`);
    }
  }
  if (issues.length > 0) throw new ProviderConformanceError(issues);

  const telemetryCoverage = Object.fromEntries(USAGE_METRICS.map((metric) => {
    const coverage: { observed: number; unknown: number; notApplicable: number } = {
      observed: 0,
      unknown: 0,
      notApplicable: 0,
    };
    for (const receipt of receipts) {
      const state = receipt.telemetry.find((item) => item.metric === metric)!.state;
      if (state === "observed") coverage.observed += 1;
      else if (state === "unknown") coverage.unknown += 1;
      else coverage.notApplicable += 1;
    }
    return [metric, Object.freeze(coverage)];
  })) as Record<UsageMetric, TelemetryCoverage>;
  return Object.freeze({
    schemaVersion: PROVIDER_CONFORMANCE_MATRIX_VERSION,
    logicalJob: receipts[0]!.logicalJob,
    topologyCount: topologies.size,
    receipts: Object.freeze([...receipts].sort((left, right) => left.receiptKey.localeCompare(right.receiptKey))),
    telemetryCoverage: Object.freeze(telemetryCoverage),
  });
}
