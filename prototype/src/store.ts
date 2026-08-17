import { createHash, randomUUID } from "node:crypto";
import { findingDeliveryEvent, signDeliveryEvent, terminalDeliveryEvent, verifySignedDeliveryEvent, type EventSigningOptions } from "./events.ts";
import type {
  DeliveryEvent,
  Finding,
  LivenessIncident,
  LivenessResult,
  RunRecord,
  Scope,
  SignedDeliveryEvent,
  StreamExpectation,
  SubmittedEvidence,
  TerminalRunStatus,
} from "./types.ts";
import {
  canonicalJson,
  enforceBatchLimits,
  enforceEvidenceSecurity,
  enforceFindingSecurity,
  resolveSecurityPolicy,
  type SecurityPolicy,
} from "./security.ts";

function iso(date: Date): string { return date.toISOString(); }
function clone<T>(value: T): T { return structuredClone(value); }
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function assertTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid_timestamp:${field}`);
  return timestamp;
}
function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${field}`);
}

interface BatchReceipt { payloadHash: string; }

/**
 * The in-memory implementation deliberately mirrors a durable port: accepted
 * incidents/events are append-only records and read methods always clone them.
 * A database adapter can replace these maps without changing lifecycle logic.
 */
export interface LivenessStorePort {
  registerExpectation(input: RegisterExpectationInput): StreamExpectation;
  evaluateLiveness(now: string): LivenessResult[];
  listLivenessIncidents(streamId?: string): LivenessIncident[];
}

export interface EventStorePort {
  listEvents(runId?: string): DeliveryEvent[];
  findingEvents(runId: string, occurredAt?: string): DeliveryEvent[];
  runTerminalEvent(runId: string, occurredAt?: string): DeliveryEvent;
}

export interface AgentFeedStorePort extends LivenessStorePort, EventStorePort {}

export type RegisterExpectationInput = Omit<StreamExpectation, "lastTerminalRunAt" | "lastTerminalStatus" | "lastTerminalRunId" | "lastTerminalFindingCount" | "nextDueAt"> & {
  lastTerminalRunAt?: string | null;
  lastTerminalStatus?: TerminalRunStatus | null;
  lastTerminalRunId?: string | null;
  lastTerminalFindingCount?: number | null;
};

export class AgentFeedStore implements AgentFeedStorePort {
  #runs = new Map<string, RunRecord>();
  #beginKeys = new Map<string, { runId: string; payloadHash: string }>();
  #batchKeys = new Map<string, BatchReceipt>();
  #expectations = new Map<string, StreamExpectation>();
  readonly #security: SecurityPolicy;
  #incidents = new Map<string, LivenessIncident>();
  #openIncidentByStream = new Map<string, string>();
  #events = new Map<string, DeliveryEvent>();

  constructor(options: { security?: Partial<SecurityPolicy> } = {}) {
    this.#security = resolveSecurityPolicy(options.security);
  }

  beginRun(input: {
    runId?: string; streamId: string; producerId: string; idempotencyKey: string;
    startedAt: string; expectedScope: Scope;
  }): RunRecord {
    assertTimestamp(input.startedAt, "startedAt");
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
    occurredAt?: string;
  }, options: { security?: SecurityPolicy } = {}): RunRecord {
    const run = this.#runs.get(input.runId);
    if (!run) throw new Error(`run_not_found:${input.runId}`);
    if (run.status !== "running") throw new Error(`terminal_run_immutable:${input.runId}`);
    const occurredAt = input.occurredAt ?? run.startedAt;
    assertTimestamp(occurredAt, "occurredAt");
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
    for (const item of input.findings) {
      this.#appendEvent(
        findingDeliveryEvent(
          run,
          item.findingId,
          occurredAt,
        ),
      );
    }
    return clone(run);
  }

  completeRun(input: {
    runId: string; idempotencyKey: string; status: Exclude<RunRecord["status"], "running">; completedAt: string;
    actualScope: Scope; sourcesAttempted: number; sourcesSucceeded: number; errorSummary?: string | null;
  }): RunRecord {
    const run = this.#runs.get(input.runId);
    if (!run) throw new Error(`run_not_found:${input.runId}`);
    const completedAtMs = assertTimestamp(input.completedAt, "completedAt");
    const payloadHash = hash(input);
    if (run.status !== "running") {
      if (run.completeIdempotencyKey === input.idempotencyKey && run.completePayloadHash === payloadHash) return clone(run);
      throw new Error(`terminal_run_immutable:${input.runId}`);
    }
    if (completedAtMs < assertTimestamp(run.startedAt, "startedAt")) throw new Error("completion_before_start");
    assertNonNegativeInteger(input.sourcesAttempted, "sources_attempted");
    assertNonNegativeInteger(input.sourcesSucceeded, "sources_succeeded");
    if (input.sourcesSucceeded > input.sourcesAttempted) throw new Error("invalid_scope_stats");
    run.status = input.status; run.completedAt = input.completedAt; run.actualScope = clone(input.actualScope);
    run.stats.sourcesAttempted = input.sourcesAttempted; run.stats.sourcesSucceeded = input.sourcesSucceeded;
    run.errorSummary = input.errorSummary ?? null;
    run.completeIdempotencyKey = input.idempotencyKey; run.completePayloadHash = payloadHash;
    const expectation = this.#expectations.get(run.streamId);
    if (expectation) {
      const previousTerminalAt = expectation.lastTerminalRunAt
        ? assertTimestamp(expectation.lastTerminalRunAt, "lastTerminalRunAt")
        : Number.NEGATIVE_INFINITY;
      // A late completion must not move consumer-owned cadence backwards.
      if (completedAtMs >= previousTerminalAt) {
        expectation.lastTerminalRunAt = input.completedAt;
        expectation.lastTerminalStatus = input.status;
        expectation.lastTerminalRunId = run.runId;
        expectation.lastTerminalFindingCount = run.findings.length;
        expectation.nextDueAt = this.#nextDueAt(expectation, completedAtMs);
      }
      this.#resolveMissedRunIncident(run.streamId, input.completedAt, run.runId);
    }
    this.#appendEvent(terminalDeliveryEvent(run));
    return clone(run);
  }

  registerExpectation(
    input: RegisterExpectationInput,
  ): StreamExpectation {
    if (!input.streamId) throw new Error("stream_id_required");
    if (!Number.isSafeInteger(input.expectedCadenceSeconds) || input.expectedCadenceSeconds < 3600) {
      throw new Error("invalid_expected_cadence");
    }
    if (!Number.isSafeInteger(input.graceSeconds) || input.graceSeconds < 0) {
      throw new Error("invalid_grace_seconds");
    }
    const last = input.lastTerminalRunAt ?? null;
    const lastMs = last === null ? null : assertTimestamp(last, "lastTerminalRunAt");
    if (input.lastTerminalFindingCount !== undefined && input.lastTerminalFindingCount !== null) {
      assertNonNegativeInteger(input.lastTerminalFindingCount, "last_terminal_finding_count");
    }
    const expectation: StreamExpectation = {
      ...clone(input),
      lastTerminalRunAt: last,
      lastTerminalStatus: input.lastTerminalStatus ?? null,
      lastTerminalRunId: input.lastTerminalRunId ?? null,
      lastTerminalFindingCount: input.lastTerminalFindingCount ?? null,
      nextDueAt: lastMs === null ? null : this.#nextDueAt(input, lastMs),
    };
    this.#expectations.set(input.streamId, expectation);
    return clone(expectation);
  }

  evaluateLiveness(now: string): LivenessResult[] {
    const timestamp = assertTimestamp(now, "now");
    const results = [...this.#expectations.values()].map((item) => {
      let status: LivenessResult["status"];
      const lastTerminalStatus = item.lastTerminalStatus;
      const hasTerminal = item.lastTerminalRunAt !== null && item.nextDueAt !== null;
      const degraded = lastTerminalStatus !== null && lastTerminalStatus !== "completed";
      const expectedAt = item.lastTerminalRunAt === null
        ? null
        : assertTimestamp(item.lastTerminalRunAt, "lastTerminalRunAt") + item.expectedCadenceSeconds * 1000;
      const overdueAt = item.nextDueAt === null ? null : assertTimestamp(item.nextDueAt, "nextDueAt");

      if (!item.enabled) status = "disabled";
      else if (!hasTerminal) status = "never_seen";
      else if (overdueAt !== null && timestamp > overdueAt) status = "overdue";
      else if (degraded) status = "degraded";
      else if (expectedAt !== null && timestamp >= expectedAt) status = "due";
      else status = "healthy";

      if (status === "overdue") this.#openMissedRunIncident(item, now);
      else if (status !== "disabled") this.#resolveMissedRunIncidentIfHealthy(item.streamId, now);

      const run = item.lastTerminalRunId === null ? null : this.#runs.get(item.lastTerminalRunId);
      const actualSourceIds = run?.actualScope?.sourceIds;
      const affectedSourceIds = degraded && actualSourceIds
        ? item.expectedSourceIds.filter((sourceId) => !actualSourceIds.includes(sourceId))
        : degraded || status === "overdue"
          ? clone(item.expectedSourceIds)
          : [];
      const observation = this.#observation(item, hasTerminal);
      return {
        streamId: item.streamId,
        status,
        observation,
        nextDueAt: item.nextDueAt,
        affectedSourceIds,
        lastTerminalStatus: item.lastTerminalStatus,
        lastTerminalRunAt: item.lastTerminalRunAt,
        lastTerminalRunId: item.lastTerminalRunId,
        lastTerminalFindingCount: item.lastTerminalFindingCount,
        incident: null,
      };
    });
    return results.map((result) => ({
      ...result,
      incident: this.#openIncidentForStream(result.streamId),
    }));
  }

  sweepLiveness(now: string): LivenessResult[] {
    return this.evaluateLiveness(now);
  }

  getRun(runId: string): RunRecord | null { const run = this.#runs.get(runId); return run ? clone(run) : null; }

  getExpectation(streamId: string): StreamExpectation | null {
    const expectation = this.#expectations.get(streamId);
    return expectation ? clone(expectation) : null;
  }

  listLivenessIncidents(streamId?: string): LivenessIncident[] {
    return [...this.#incidents.values()]
      .filter((incident) => streamId === undefined || incident.streamId === streamId)
      .map((incident) => clone(incident));
  }

  listIncidents(streamId?: string): LivenessIncident[] {
    return this.listLivenessIncidents(streamId);
  }

  getLivenessIncident(incidentId: string): LivenessIncident | null {
    const incident = this.#incidents.get(incidentId);
    return incident ? clone(incident) : null;
  }

  getOpenIncident(streamId: string): LivenessIncident | null {
    return this.#openIncidentForStream(streamId);
  }

  /** Explicit append-only event read port used by durable adapters/tests. */
  listEvents(runId?: string): DeliveryEvent[] {
    return [...this.#events.values()]
      .filter((event) => runId === undefined || event.runId === runId)
      .map((event) => clone(event));
  }

  deliveryEvents(runId?: string): DeliveryEvent[] {
    return this.listEvents(runId);
  }

  findingEvents(runId: string, occurredAt?: string): DeliveryEvent[] {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    if (occurredAt !== undefined) assertTimestamp(occurredAt, "occurredAt");
    return run.findings.map((finding) => {
      const eventId = `evt_${runId}_${finding.findingId}`;
      const persisted = this.#events.get(eventId);
      if (persisted) return clone(persisted);
      const event = findingDeliveryEvent(run, finding.findingId, occurredAt ?? run.startedAt);
      this.#appendEvent(event);
      return clone(event);
    });
  }

  runTerminalEvent(runId: string, occurredAt?: string): DeliveryEvent {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    if (run.status === "running") throw new Error(`run_not_terminal:${runId}`);
    const eventId = `evt_${runId}_terminal`;
    const persisted = this.#events.get(eventId);
    if (persisted) return clone(persisted);
    const event = terminalDeliveryEvent(run, occurredAt);
    this.#appendEvent(event);
    return clone(event);
  }

  terminalEvent(runId: string, occurredAt?: string): DeliveryEvent {
    return this.runTerminalEvent(runId, occurredAt);
  }

  terminalEvents(runId: string, occurredAt?: string): DeliveryEvent[] {
    return [this.runTerminalEvent(runId, occurredAt)];
  }

  signedFindingEvents(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent[] {
    const events = this.findingEvents(runId, options.occurredAt);
    return events.map((event) => signDeliveryEvent(event, secret, options));
  }

  signedRunTerminalEvent(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent {
    const event = this.runTerminalEvent(runId, options.occurredAt);
    return signDeliveryEvent(event, secret, options);
  }

  signedTerminalEvent(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent {
    return this.signedRunTerminalEvent(runId, secret, options);
  }

  signedTerminalEvents(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent[] {
    return [this.signedRunTerminalEvent(runId, secret, options)];
  }

  signedEvents(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent[] {
    return [
      ...this.signedFindingEvents(runId, secret, options),
      this.signedRunTerminalEvent(runId, secret, options),
    ];
  }

  signedDeliveryEvents(
    runId: string,
    secret: string,
    options: EventSigningOptions & { occurredAt?: string } = {},
  ): SignedDeliveryEvent[] {
    return this.signedEvents(runId, secret, options);
  }

  verifySignedEvent(event: SignedDeliveryEvent, secret: string, nowSeconds?: number): boolean {
    return verifySignedDeliveryEvent(event, secret, nowSeconds);
  }

  #appendEvent(event: DeliveryEvent): void {
    const existing = this.#events.get(event.eventId);
    if (existing) return;
    this.#events.set(event.eventId, clone(event));
  }

  #nextDueAt(
    expectation: Pick<StreamExpectation, "expectedCadenceSeconds" | "graceSeconds">,
    lastTerminalAtMs: number,
  ): string {
    return iso(new Date(lastTerminalAtMs + (expectation.expectedCadenceSeconds + expectation.graceSeconds) * 1000));
  }

  #observation(
    expectation: StreamExpectation,
    hasTerminal: boolean,
  ): LivenessResult["observation"] {
    if (!hasTerminal || expectation.lastTerminalStatus === null) return "absent_run";
    switch (expectation.lastTerminalStatus) {
      case "partial":
        return "partial";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "completed":
        return expectation.lastTerminalFindingCount === 0 ? "zero_findings" : "findings";
    }
  }

  #openIncidentForStream(streamId: string): LivenessIncident | null {
    const incidentId = this.#openIncidentByStream.get(streamId);
    if (!incidentId) return null;
    const incident = this.#incidents.get(incidentId);
    return incident ? clone(incident) : null;
  }

  #openMissedRunIncident(expectation: StreamExpectation, detectedAt: string): LivenessIncident {
    const existing = this.#openIncidentForStream(expectation.streamId);
    if (existing) return existing;
    const expectedBy = expectation.nextDueAt;
    const incidentId = `incident_${hash({ streamId: expectation.streamId, incidentType: "missed_run", expectedBy }).slice(0, 32)}`;
    const old = this.#incidents.get(incidentId);
    if (old) {
      // A deterministic expected window can be swept repeatedly. If an old
      // resolved row happens to have the same key, retain it and make a new
      // auditable row rather than mutating history.
      const suffix = this.#incidents.size + 1;
      return this.#openMissedRunIncidentWithId(expectation, detectedAt, `${incidentId}_${suffix}`);
    }
    return this.#openMissedRunIncidentWithId(expectation, detectedAt, incidentId);
  }

  #openMissedRunIncidentWithId(
    expectation: StreamExpectation,
    detectedAt: string,
    incidentId: string,
  ): LivenessIncident {
    const incident: LivenessIncident = {
      incidentId,
      streamId: expectation.streamId,
      incidentType: "missed_run",
      status: "open",
      detectedAt,
      expectedBy: expectation.nextDueAt,
      resolvedAt: null,
      details: {
        lastTerminalRunAt: expectation.lastTerminalRunAt,
        lastTerminalRunId: expectation.lastTerminalRunId,
        expectedSourceIds: clone(expectation.expectedSourceIds),
      },
    };
    this.#incidents.set(incident.incidentId, incident);
    this.#openIncidentByStream.set(expectation.streamId, incident.incidentId);
    return clone(incident);
  }

  #resolveMissedRunIncidentIfHealthy(streamId: string, resolvedAt: string): void {
    const openId = this.#openIncidentByStream.get(streamId);
    if (!openId) return;
    const incident = this.#incidents.get(openId);
    if (!incident || incident.status === "resolved") {
      this.#openIncidentByStream.delete(streamId);
      return;
    }
    incident.status = "resolved";
    incident.resolvedAt = resolvedAt;
    incident.details = { ...incident.details, resolution: "terminal_run_observed" };
    this.#openIncidentByStream.delete(streamId);
  }

  #resolveMissedRunIncident(streamId: string, resolvedAt: string, runId: string): void {
    const openId = this.#openIncidentByStream.get(streamId);
    if (!openId) return;
    const incident = this.#incidents.get(openId);
    if (!incident || incident.status === "resolved") {
      this.#openIncidentByStream.delete(streamId);
      return;
    }
    incident.status = "resolved";
    incident.resolvedAt = resolvedAt;
    incident.details = {
      ...incident.details,
      resolution: "terminal_run_observed",
      recoveredByRunId: runId,
    };
    this.#openIncidentByStream.delete(streamId);
  }
}
