import {
  OccurrenceCoreError,
  type DerivedInvocationOutcome,
  type ExpectedOccurrence,
  type InvocationCandidate,
  type InvocationCandidateInput,
  type MatchRequest,
  type MatchResult,
  type ScheduleExpectation,
  type ScheduleExpectationInput,
} from "./types.ts";
import { normalizeExpectation, normalizeUtcInstant, parseUtcInstant } from "./validation.ts";

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function rejected(reason: MatchResult["reason"], runId: string | null, run: InvocationCandidate | null = null, occurrenceKey: string | null = null): MatchResult {
  return {
    matched: false,
    decision: "rejected",
    reason,
    occurrenceKey,
    runId,
    derivedOutcome: deriveInvocationOutcome(run, false),
  };
}

function normalizeCandidate(input: InvocationCandidate | InvocationCandidateInput | undefined): InvocationCandidate | null {
  if (input === undefined || input === null || typeof input !== "object") return null;
  const value = input as InvocationCandidateInput;
  const runId = firstDefined(value.runId, value.run_id);
  const triggerKind = firstDefined(value.triggerKind, value.trigger_kind);
  const status = firstDefined(value.status, value.runStatus, value.run_status);
  const startedAt = firstDefined(value.startedAt, value.started_at, value.invokedAt, value.invoked_at);
  if (typeof runId !== "string" || runId.length === 0 || triggerKind === undefined || status === undefined || typeof startedAt !== "string") return null;
  const expectationId = firstDefined(value.expectationId, value.expectation_id);
  const expectationVersion = firstDefined(value.expectationVersion, value.expectation_version);
  const occurrenceKey = firstDefined(value.occurrenceKey, value.occurrence_key);
  const completedAt = firstDefined(value.completedAt, value.completed_at);
  const findingsCount = firstDefined(value.findingsCount, value.findings_count);
  return {
    runId,
    triggerKind,
    status,
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(expectationId === undefined ? {} : { expectationId }),
    ...(expectationVersion === undefined ? {} : { expectationVersion }),
    ...(occurrenceKey === undefined ? {} : { occurrenceKey }),
    ...(findingsCount === undefined ? {} : { findingsCount }),
    ...(value.invocationState === undefined ? {} : { invocationState: value.invocationState }),
  };
}

/**
 * Derive execution outcome only after the caller has established whether the
 * run proves an invocation. A completed run with findingsCount=0 remains a
 * successful completion; it is not absence.
 */
export function deriveInvocationOutcome(runInput: InvocationCandidate | InvocationCandidateInput | null | undefined, invocationProven = true): DerivedInvocationOutcome {
  const run = runInput === null || runInput === undefined ? null : normalizeCandidate(runInput);
  if (run === null || !invocationProven) return { outcome: "absence", invocationProven: false, findingsCount: null, runId: run?.runId ?? null };
  const findingsCount = run.findingsCount === null || run.findingsCount === undefined ? null : run.findingsCount;
  switch (run.status) {
    case "running": return { outcome: "running_invocation", invocationProven: true, findingsCount, runId: run.runId };
    case "completed": return { outcome: "successful_completed", invocationProven: true, findingsCount, runId: run.runId };
    case "partial": return { outcome: "partial", invocationProven: true, findingsCount, runId: run.runId };
    case "failed": return { outcome: "failed", invocationProven: true, findingsCount, runId: run.runId };
    case "cancelled": return { outcome: "cancelled", invocationProven: true, findingsCount, runId: run.runId };
  }
}

export const deriveRunOutcome = deriveInvocationOutcome;
export const classifyInvocationOutcome = deriveInvocationOutcome;

function inWindow(occurrence: ExpectedOccurrence, startedMs: number): boolean {
  const expectedMs = parseUtcInstant(occurrence.expectedAt, "occurrence.expectedAt");
  const windowEndMs = parseUtcInstant(occurrence.windowEndsAt, "occurrence.windowEndsAt");
  return startedMs >= expectedMs && startedMs <= windowEndMs;
}

function normalizedExplicitKey(input: MatchRequest, run: InvocationCandidate): string | null {
  const value = firstDefined(input.explicitOccurrenceKey, input.explicit_occurrence_key, run.occurrenceKey);
  return value === undefined || value === null ? null : value;
}

function candidateExpectationReason(expectation: ScheduleExpectation, run: InvocationCandidate): MatchResult["reason"] | null {
  if (run.expectationId !== undefined && run.expectationId !== null && run.expectationId !== expectation.expectationId) return "expectation_mismatch";
  if (run.expectationVersion !== undefined && run.expectationVersion !== null && run.expectationVersion !== expectation.expectationVersion) return "version_mismatch";
  return null;
}

function matchingTriggerAllowed(expectation: ScheduleExpectation, run: InvocationCandidate): MatchResult["reason"] | null {
  if (expectation.matchingMode === "legacy") {
    if (run.triggerKind === "legacy" || run.triggerKind === "scheduled") return null;
    return run.triggerKind === "manual" || run.triggerKind === "test" || run.triggerKind === "retry" || run.triggerKind === "replay" || run.triggerKind === "backfill" || run.triggerKind === "event" || run.triggerKind === "unknown"
      ? "unsupported_trigger"
      : "missing_scheduled_trigger";
  }
  if (run.triggerKind === "scheduled") return null;
  if (run.triggerKind === "legacy") return "unsupported_trigger";
  return run.triggerKind === "manual" || run.triggerKind === "test" || run.triggerKind === "retry" || run.triggerKind === "replay" || run.triggerKind === "backfill" || run.triggerKind === "event" || run.triggerKind === "unknown"
    ? "unsupported_trigger"
    : "missing_scheduled_trigger";
}

function occurrenceMatchesExpectation(expectation: ScheduleExpectation, occurrence: ExpectedOccurrence): boolean {
  return occurrence.schemaVersion === "agent-feed.expected-occurrence.v1"
    && occurrence.expectationId === expectation.expectationId
    && occurrence.expectationVersion === expectation.expectationVersion;
}

/**
 * Match one invocation against a bounded set of expected occurrences. The
 * function has no database side effects; adapters persist the returned link.
 * Ambiguous windows and duplicate links are rejected rather than guessed.
 */
export function matchOccurrence(input: MatchRequest): MatchResult {
  let expectation: ScheduleExpectation;
  try {
    expectation = normalizeExpectation(input.expectation);
  } catch {
    return rejected("invalid_candidate", null);
  }
  const run = normalizeCandidate(input.run ?? input.candidate);
  if (run === null) return rejected("invalid_candidate", null);
  const runId = run.runId;
  const triggerReason = matchingTriggerAllowed(expectation, run);
  if (triggerReason !== null) return rejected(triggerReason, runId, run);
  const expectationReason = candidateExpectationReason(expectation, run);
  if (expectationReason !== null) return rejected(expectationReason, runId, run);
  const startedIssues: { code: string; path: string; message: string }[] = [];
  if (normalizeUtcInstant(run.startedAt, "run.startedAt", startedIssues) === undefined) return rejected("invalid_candidate", runId, run);
  const suppliedOccurrences = input.occurrences ?? (input.occurrence === undefined ? [] : [input.occurrence]);
  const keys = new Set<string>();
  for (const occurrence of suppliedOccurrences) {
    if (!occurrenceMatchesExpectation(expectation, occurrence)) continue;
    if (keys.has(occurrence.occurrenceKey)) return rejected("duplicate_occurrence_key", runId, run);
    keys.add(occurrence.occurrenceKey);
  }
  const occurrences = suppliedOccurrences.filter((occurrence) => occurrenceMatchesExpectation(expectation, occurrence));
  if (occurrences.length === 0) return rejected("occurrence_not_in_candidates", runId, run);
  const linked = new Set(input.linkedOccurrenceKeys ?? input.linked_occurrence_keys ?? []);
  let target: ExpectedOccurrence | undefined;
  if (expectation.matchingMode === "explicit") {
    const explicitKey = normalizedExplicitKey(input, run);
    if (explicitKey === null || explicitKey.length === 0) return rejected("missing_explicit_occurrence", runId, run);
    if (run.occurrenceKey !== undefined && run.occurrenceKey !== null && run.occurrenceKey !== explicitKey) return rejected("explicit_occurrence_mismatch", runId, run, explicitKey);
    const matching = occurrences.filter((occurrence) => occurrence.occurrenceKey === explicitKey);
    if (matching.length !== 1) return rejected(matching.length === 0 ? "occurrence_not_in_candidates" : "duplicate_occurrence_key", runId, run, explicitKey);
    target = matching[0];
  } else {
    let startedMs: number;
    try {
      const issues: { code: string; path: string; message: string }[] = [];
      const normalizedStartedAt = normalizeUtcInstant(run.startedAt, "run.startedAt", issues);
      if (normalizedStartedAt === undefined) return rejected("invalid_candidate", runId, run);
      startedMs = parseUtcInstant(normalizedStartedAt, "run.startedAt");
    } catch {
      return rejected("invalid_candidate", runId, run);
    }
    const matching = occurrences.filter((occurrence) => inWindow(occurrence, startedMs));
    if (matching.length === 0) {
      const linkedMatching = occurrences.filter((occurrence) => linked.has(occurrence.occurrenceKey));
      return rejected(linkedMatching.length > 0 ? "already_linked" : "outside_window", runId, run);
    }
    if (matching.length !== 1) return rejected("ambiguous_window", runId, run);
    target = matching[0];
  }
  if (target === undefined) return rejected("occurrence_not_in_candidates", runId, run);
  if (linked.has(target.occurrenceKey)) return rejected("already_linked", runId, run, target.occurrenceKey);
  const reason = expectation.matchingMode === "explicit" ? "matched_explicit" : expectation.matchingMode === "legacy" ? "matched_legacy" : "matched_window";
  return {
    matched: true,
    decision: "satisfied",
    reason,
    occurrenceKey: target.occurrenceKey,
    runId,
    derivedOutcome: deriveInvocationOutcome(run, true),
  };
}

export const matchRunToOccurrence = matchOccurrence;
export const matchInvocation = matchOccurrence;

/**
 * Match a group while enforcing the one-run/one-occurrence invariant across
 * the whole group. A duplicate run ID or already claimed occurrence is
 * rejected in the returned result instead of silently overwriting a link.
 */
export function matchInvocations(input: {
  readonly expectation: ScheduleExpectation | ScheduleExpectationInput;
  readonly runs: readonly (InvocationCandidate | InvocationCandidateInput)[];
  readonly occurrences: readonly ExpectedOccurrence[];
  readonly linkedOccurrenceKeys?: readonly string[];
}): readonly MatchResult[] {
  const linked = new Set(input.linkedOccurrenceKeys ?? []);
  const seenRuns = new Set<string>();
  const results: MatchResult[] = [];
  for (const runInput of input.runs) {
    const run = normalizeCandidate(runInput);
    if (run !== null && seenRuns.has(run.runId)) {
      results.push(rejected("already_linked", run.runId, run));
      continue;
    }
    if (run !== null) seenRuns.add(run.runId);
    const result = matchOccurrence({ expectation: input.expectation, run: runInput, occurrences: input.occurrences, linkedOccurrenceKeys: [...linked] });
    if (result.matched && result.occurrenceKey !== null) linked.add(result.occurrenceKey);
    results.push(result);
  }
  return results;
}
