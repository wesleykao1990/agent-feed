import { createHash, randomUUID } from "node:crypto";
import type { DeliveryEvent, Finding, LivenessResult, RunRecord, Scope, StreamExpectation, SubmittedEvidence } from "./types.ts";
import {
  enforceBatchLimits,
  enforceEvidenceSecurity,
  enforceFindingSecurity,
  resolveSecurityPolicy,
  type SecurityPolicy,
} from "./security.ts";

function iso(date: Date): string { return date.toISOString(); }
function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

interface BatchReceipt { payloadHash: string; }

export class AgentFeedStore {
  #runs = new Map<string, RunRecord>();
  #beginKeys = new Map<string, { runId: string; payloadHash: string }>();
  #batchKeys = new Map<string, BatchReceipt>();
  #expectations = new Map<string, StreamExpectation>();
  readonly #security: SecurityPolicy;

  constructor(options: { security?: Partial<SecurityPolicy> } = {}) {
    this.#security = resolveSecurityPolicy(options.security);
  }

  beginRun(input: {
    runId?: string; streamId: string; producerId: string; idempotencyKey: string;
    startedAt: string; expectedScope: Scope;
  }): RunRecord {
    const compound = `${input.producerId}|${input.streamId}|${input.idempotencyKey}`;
    const payloadHash = hash(input);
    const existing = this.#beginKeys.get(compound);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("idempotency_payload_conflict");
      return clone(this.#runs.get(existing.runId)!);
    }
    const runId = input.runId ?? randomUUID();
    if (this.#runs.has(runId)) throw new Error(`run_id_conflict:${runId}`);
    const run: RunRecord = {
      runId, streamId: input.streamId, producerId: input.producerId,
      beginIdempotencyKey: input.idempotencyKey, beginPayloadHash: payloadHash,
      completeIdempotencyKey: null, completePayloadHash: null,
      status: "running", startedAt: input.startedAt, completedAt: null,
      expectedScope: clone(input.expectedScope), actualScope: null,
      findings: [], evidence: [],
      stats: { sourcesAttempted: 0, sourcesSucceeded: 0, batchesSubmitted: 0 },
      errorSummary: null,
    };
    this.#runs.set(runId, run);
    this.#beginKeys.set(compound, { runId, payloadHash });
    return clone(run);
  }

  submitBatch(input: {
    runId: string; batchId: string; idempotencyKey: string;
    findings: Finding[]; evidence: SubmittedEvidence[];
  }, options: { security?: SecurityPolicy } = {}): RunRecord {
    const run = this.#runs.get(input.runId);
    if (!run) throw new Error(`run_not_found:${input.runId}`);
    if (run.status !== "running") throw new Error(`terminal_run_immutable:${input.runId}`);
    const security = options.security ?? this.#security;
    enforceBatchLimits(input.findings, input.evidence, security);
    for (const evidence of input.evidence) {
      enforceEvidenceSecurity(
        {
          ...evidence,
          ...(evidence.wirePayload === undefined ? {} : { wirePayload: evidence.wirePayload }),
          metadata: evidence.wirePayload?.metadata,
        },
        security,
        { runId: input.runId },
      );
    }
    for (const finding of input.findings) {
      enforceFindingSecurity(
        {
          ...finding,
          ...(finding.wirePayload === undefined ? {} : { wirePayload: finding.wirePayload }),
        },
        security,
        { runId: input.runId },
      );
    }

    const compound = `${input.runId}|${input.idempotencyKey}`;
    const payloadHash = hash({ findings: input.findings, evidence: input.evidence });
    const old = this.#batchKeys.get(compound);
    if (old) {
      if (old.payloadHash !== payloadHash) throw new Error("idempotency_payload_conflict");
      return clone(run);
    }

    const acceptedEvidence = new Set([...run.evidence.map((item) => item.evidenceId), ...input.evidence.map((item) => item.evidenceId)]);
    const newEvidenceIds = new Set<string>();
    for (const evidence of input.evidence) {
      if (newEvidenceIds.has(evidence.evidenceId) || run.evidence.some((oldEvidence) => oldEvidence.evidenceId === evidence.evidenceId)) throw new Error(`duplicate_evidence:${evidence.evidenceId}`);
      newEvidenceIds.add(evidence.evidenceId);
    }
    const newFindingIds = new Set<string>();
    for (const finding of input.findings) {
      for (const ref of finding.evidenceRefs) if (!acceptedEvidence.has(ref)) throw new Error(`unresolved_evidence_ref:${ref}`);
      if (newFindingIds.has(finding.findingId) || run.findings.some((oldFinding) => oldFinding.findingId === finding.findingId)) throw new Error(`duplicate_finding:${finding.findingId}`);
      newFindingIds.add(finding.findingId);
    }
    run.findings.push(...clone(input.findings));
    run.evidence.push(...clone(input.evidence));
    run.stats.batchesSubmitted += 1;
    this.#batchKeys.set(compound, { payloadHash });
    return clone(run);
  }

  completeRun(input: {
    runId: string; idempotencyKey: string; status: Exclude<RunRecord["status"], "running">; completedAt: string;
    actualScope: Scope; sourcesAttempted: number; sourcesSucceeded: number; errorSummary?: string | null;
  }): RunRecord {
    const run = this.#runs.get(input.runId);
    if (!run) throw new Error(`run_not_found:${input.runId}`);
    const payloadHash = hash(input);
    if (run.status !== "running") {
      if (run.completeIdempotencyKey === input.idempotencyKey && run.completePayloadHash === payloadHash) return clone(run);
      throw new Error(`terminal_run_immutable:${input.runId}`);
    }
    if (Date.parse(input.completedAt) < Date.parse(run.startedAt)) throw new Error("completion_before_start");
    if (input.sourcesSucceeded > input.sourcesAttempted) throw new Error("invalid_scope_stats");
    run.status = input.status; run.completedAt = input.completedAt; run.actualScope = clone(input.actualScope);
    run.stats.sourcesAttempted = input.sourcesAttempted; run.stats.sourcesSucceeded = input.sourcesSucceeded;
    run.errorSummary = input.errorSummary ?? null;
    run.completeIdempotencyKey = input.idempotencyKey; run.completePayloadHash = payloadHash;
    const expectation = this.#expectations.get(run.streamId);
    if (expectation) {
      expectation.lastTerminalRunAt = input.completedAt;
      expectation.lastTerminalStatus = input.status;
      const due = new Date(Date.parse(input.completedAt) + (expectation.expectedCadenceSeconds + expectation.graceSeconds) * 1000);
      expectation.nextDueAt = iso(due);
    }
    return clone(run);
  }

  registerExpectation(
    input: Omit<StreamExpectation, "lastTerminalRunAt" | "lastTerminalStatus" | "nextDueAt"> & {
      lastTerminalRunAt?: string | null;
      lastTerminalStatus?: StreamExpectation["lastTerminalStatus"];
    },
  ): StreamExpectation {
    const last = input.lastTerminalRunAt ?? null;
    const next = last
      ? iso(
          new Date(
            Date.parse(last) +
              (input.expectedCadenceSeconds + input.graceSeconds) * 1000,
          ),
        )
      : null;
    const expectation: StreamExpectation = {
      ...clone(input),
      lastTerminalRunAt: last,
      lastTerminalStatus: input.lastTerminalStatus ?? null,
      nextDueAt: next,
    };
    this.#expectations.set(input.streamId, expectation);
    return clone(expectation);
  }

  evaluateLiveness(now: string): LivenessResult[] {
    const timestamp = Date.parse(now);
    return [...this.#expectations.values()].map((item) => {
      let status: LivenessResult["status"];
      if (!item.enabled) status = "disabled";
      else if (!item.lastTerminalRunAt || !item.nextDueAt) status = "never_seen";
      else if (timestamp > Date.parse(item.nextDueAt)) status = "overdue";
      else if (item.lastTerminalStatus && item.lastTerminalStatus !== "completed")
        status = "degraded";
      else if (
        timestamp + item.graceSeconds * 1000 >=
        Date.parse(item.nextDueAt)
      )
        status = "due";
      else status = "healthy";
      return {
        streamId: item.streamId,
        status,
        nextDueAt: item.nextDueAt,
        affectedSourceIds: clone(item.expectedSourceIds),
        lastTerminalStatus: item.lastTerminalStatus,
      };
    });
  }

  getRun(runId: string): RunRecord | null { const run = this.#runs.get(runId); return run ? clone(run) : null; }

  findingEvents(runId: string, occurredAt: string): DeliveryEvent[] {
    const run = this.#runs.get(runId); if (!run) throw new Error(`run_not_found:${runId}`);
    return run.findings.map((finding) => ({
      protocolVersion: "0.1", eventId: `evt_${runId}_${finding.findingId}`,
      eventType: "finding.submitted", streamId: run.streamId, runId,
      findingId: finding.findingId, occurredAt,
      payload: { finding: clone(finding), submittedEvidence: clone(run.evidence.filter((evidence) => finding.evidenceRefs.includes(evidence.evidenceId))) },
    }));
  }
}
