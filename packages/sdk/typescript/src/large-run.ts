import { createHash } from "node:crypto";
import type {
  Finding,
  SubmitBatchRequest,
  SubmittedEvidence,
} from "../generated/protocol.ts";

export const LARGE_RUN_DEFAULTS = Object.freeze({
  max_body_bytes: 1_048_576,
  max_findings_per_batch: 100,
  max_evidence_per_batch: 100,
});

/**
 * One atomic planning unit for a large producer run.
 *
 * A unit is never split across protocol batches. This lets callers keep a
 * finding beside the evidence it introduces while the planner still streams
 * many units with bounded per-request memory.
 */
export interface LargeRunUnit {
  findings: readonly Finding[];
  evidence: readonly SubmittedEvidence[];
}

export interface LargeRunBatchPlanOptions {
  /** Fixed across retries so regenerated batches retain the same identity. */
  submitted_at: string;
  metadata?: Readonly<Record<string, unknown>>;
  start_sequence_number?: number;
  max_body_bytes?: number;
  max_findings_per_batch?: number;
  max_evidence_per_batch?: number;
}

type LargeRunUnits = Iterable<LargeRunUnit> | AsyncIterable<LargeRunUnit>;

function positiveInteger(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${field}_invalid`);
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("large_run_non_json_value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("large_run_cyclic_value");
    ancestors.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (!plainRecord(value)) throw new Error("large_run_non_json_value");
  if (ancestors.has(value)) throw new Error("large_run_cyclic_value");
  ancestors.add(value);
  const encoded = `{${Object.keys(value).sort().map((key) => {
    const child = value[key];
    if (child === undefined || typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") {
      throw new Error("large_run_non_json_value");
    }
    return `${JSON.stringify(key)}:${canonicalJson(child, ancestors)}`;
  }).join(",")}}`;
  ancestors.delete(value);
  return encoded;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function requestFor(
  runId: string,
  sequenceNumber: number,
  submittedAt: string,
  findings: readonly Finding[],
  evidence: readonly SubmittedEvidence[],
  metadata: Readonly<Record<string, unknown>>,
): SubmitBatchRequest {
  const stablePayload = {
    protocol_version: "0.1" as const,
    run_id: runId,
    sequence_number: sequenceNumber,
    submitted_at: submittedAt,
    findings,
    evidence,
    metadata,
  };
  const hash = digest(stablePayload);
  return {
    protocol_version: "0.1",
    run_id: runId,
    batch_id: `bulk-${String(sequenceNumber).padStart(8, "0")}-${hash.slice(0, 20)}`,
    idempotency_key: `bulk-${hash}`,
    sequence_number: sequenceNumber,
    submitted_at: submittedAt,
    findings: cloneJson([...findings]),
    evidence: cloneJson([...evidence]),
    metadata: cloneJson(metadata),
  };
}

function bodyBytes(request: SubmitBatchRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

function unitArrays(value: LargeRunUnit): { findings: Finding[]; evidence: SubmittedEvidence[] } {
  if (!plainRecord(value) || !Array.isArray(value.findings) || !Array.isArray(value.evidence)) {
    throw new Error("large_run_unit_invalid");
  }
  if (value.findings.length === 0 && value.evidence.length === 0) throw new Error("large_run_unit_empty");
  return {
    findings: cloneJson([...value.findings]),
    evidence: cloneJson([...value.evidence]),
  };
}

function itemId(value: unknown, field: "finding_id" | "evidence_id"): string {
  if (!plainRecord(value) || typeof value[field] !== "string" || value[field].length < 3) {
    throw new Error(`large_run_${field}_invalid`);
  }
  return value[field];
}

/**
 * Stream protocol-0.1 batches for a large result set.
 *
 * Batch IDs and idempotency keys are derived from canonical content. Replaying
 * the same ordered units with the same options therefore produces byte-equal
 * requests that the durable ingress can accept as exact retries.
 */
export async function* planLargeRunBatches(
  runId: string,
  units: LargeRunUnits,
  options: LargeRunBatchPlanOptions,
): AsyncGenerator<SubmitBatchRequest> {
  if (typeof runId !== "string" || runId.length < 8 || runId.trim() !== runId) throw new Error("run_id_invalid");
  if (typeof options?.submitted_at !== "string" || Number.isNaN(Date.parse(options.submitted_at))) {
    throw new Error("submitted_at_invalid");
  }
  const sequenceStart = positiveInteger(options.start_sequence_number ?? 1, "start_sequence_number");
  const maximumBodyBytes = positiveInteger(options.max_body_bytes ?? LARGE_RUN_DEFAULTS.max_body_bytes, "max_body_bytes");
  const maximumFindings = positiveInteger(options.max_findings_per_batch ?? LARGE_RUN_DEFAULTS.max_findings_per_batch, "max_findings_per_batch", 100);
  const maximumEvidence = positiveInteger(options.max_evidence_per_batch ?? LARGE_RUN_DEFAULTS.max_evidence_per_batch, "max_evidence_per_batch", 100);
  const metadata = cloneJson(options.metadata ?? {});

  const findingIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let sequenceNumber = sequenceStart;
  let pendingFindings: Finding[] = [];
  let pendingEvidence: SubmittedEvidence[] = [];

  const build = (findings: readonly Finding[], evidence: readonly SubmittedEvidence[]): SubmitBatchRequest =>
    requestFor(runId, sequenceNumber, options.submitted_at, findings, evidence, metadata);

  for await (const rawUnit of units) {
    const unit = unitArrays(rawUnit);
    const unitEvidenceIds = new Set<string>();
    for (const evidence of unit.evidence) {
      const id = itemId(evidence, "evidence_id");
      if (evidenceIds.has(id) || unitEvidenceIds.has(id)) throw new Error("large_run_duplicate_evidence_id");
      unitEvidenceIds.add(id);
    }
    const unitFindingIds = new Set<string>();
    for (const finding of unit.findings) {
      const id = itemId(finding, "finding_id");
      if (findingIds.has(id) || unitFindingIds.has(id)) throw new Error("large_run_duplicate_finding_id");
      unitFindingIds.add(id);
      if (!Array.isArray(finding.evidence_refs)) throw new Error("large_run_evidence_refs_invalid");
      for (const reference of finding.evidence_refs) {
        if (typeof reference !== "string" || (!evidenceIds.has(reference) && !unitEvidenceIds.has(reference))) {
          throw new Error("large_run_forward_or_missing_evidence_ref");
        }
      }
    }

    const candidateFindings = [...pendingFindings, ...unit.findings];
    const candidateEvidence = [...pendingEvidence, ...unit.evidence];
    const countFits = candidateFindings.length <= maximumFindings && candidateEvidence.length <= maximumEvidence;
    const candidate = countFits ? build(candidateFindings, candidateEvidence) : null;
    const bytesFit = candidate !== null && bodyBytes(candidate) <= maximumBodyBytes;

    if (!countFits || !bytesFit) {
      if (pendingFindings.length > 0 || pendingEvidence.length > 0) {
        yield build(pendingFindings, pendingEvidence);
        sequenceNumber += 1;
        pendingFindings = [];
        pendingEvidence = [];
      }
      const isolated = build(unit.findings, unit.evidence);
      if (unit.findings.length > maximumFindings || unit.evidence.length > maximumEvidence || bodyBytes(isolated) > maximumBodyBytes) {
        throw new Error("large_run_unit_exceeds_batch_limit");
      }
    }

    pendingFindings.push(...unit.findings);
    pendingEvidence.push(...unit.evidence);
    for (const id of unitFindingIds) findingIds.add(id);
    for (const id of unitEvidenceIds) evidenceIds.add(id);
  }

  if (pendingFindings.length > 0 || pendingEvidence.length > 0) yield build(pendingFindings, pendingEvidence);
}
