import {
  MAX_CATCH_UP_OCCURRENCES,
  OccurrenceCoreError,
  type ExpectedOccurrence,
  type MisfireDecision,
  type MisfirePolicy,
  type MisfireRequest,
  type MisfireResult,
  type OverlapRequest,
  type OverlapResult,
  type PriorInvocation,
  type ScheduleExpectation,
  type ScheduleExpectationInput,
} from "./types.ts";
import { normalizeExpectation, parseUtcInstant } from "./validation.ts";

function occurrenceSort(a: ExpectedOccurrence, b: ExpectedOccurrence): number {
  return a.expectedAt.localeCompare(b.expectedAt) || a.occurrenceKey.localeCompare(b.occurrenceKey);
}

function uniqueOccurrences(occurrences: readonly ExpectedOccurrence[]): void {
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.occurrenceKey)) throw new OccurrenceCoreError("invalid_candidate", "duplicate occurrence key", { path: "occurrences" });
    seen.add(occurrence.occurrenceKey);
  }
}

function resolvePolicy(request: MisfireRequest): MisfirePolicy {
  const selected = request.policy ?? request.misfirePolicy ?? request.misfire_policy ?? (request.expectation === undefined ? undefined : normalizeExpectation(request.expectation).misfirePolicy);
  if (selected === "mark_missed" || selected === "fire_latest" || selected === "catch_up") return selected;
  throw new OccurrenceCoreError("invalid_misfire_policy", "expectation is required to resolve misfirePolicy", { path: "expectation" });
}

function decisionMap(
  occurrences: readonly ExpectedOccurrence[],
  linked: ReadonlySet<string>,
  overdue: ReadonlySet<string>,
  missed: ReadonlySet<string>,
  eligible: ReadonlySet<string>,
  deferred: ReadonlySet<string>,
): MisfireDecision[] {
  return [...occurrences].sort(occurrenceSort).map((occurrence) => ({
    occurrence,
    decision: linked.has(occurrence.occurrenceKey)
      ? "linked"
      : !overdue.has(occurrence.occurrenceKey)
        ? "pending"
        : missed.has(occurrence.occurrenceKey)
          ? "missed"
          : eligible.has(occurrence.occurrenceKey)
            ? "eligible"
            : deferred.has(occurrence.occurrenceKey)
              ? "deferred"
              : "pending",
  }));
}

/**
 * Classify only overdue, unlinked occurrences. The current time and grace
 * windows are explicit inputs; no wall clock is consulted by this function.
 */
export function classifyMisfires(request: MisfireRequest): MisfireResult {
  const policy = resolvePolicy(request);
  uniqueOccurrences(request.occurrences);
  const nowMs = parseUtcInstant(request.now, "now");
  const linked = new Set(request.linkedOccurrenceKeys ?? request.linked_occurrence_keys ?? []);
  const ordered = [...request.occurrences].sort(occurrenceSort);
  const overdue = new Set<string>();
  const pending: ExpectedOccurrence[] = [];
  const linkedOccurrences: ExpectedOccurrence[] = [];
  const overdueOccurrences: ExpectedOccurrence[] = [];
  for (const occurrence of ordered) {
    const windowEndMs = parseUtcInstant(occurrence.windowEndsAt, "occurrence.windowEndsAt");
    if (linked.has(occurrence.occurrenceKey)) {
      linkedOccurrences.push(occurrence);
    } else if (nowMs > windowEndMs) {
      overdue.add(occurrence.occurrenceKey);
      overdueOccurrences.push(occurrence);
    } else {
      pending.push(occurrence);
    }
  }
  const missed = new Set<string>();
  const eligible = new Set<string>();
  const deferred = new Set<string>();
  if (policy === "mark_missed") {
    for (const occurrence of overdueOccurrences) missed.add(occurrence.occurrenceKey);
  } else if (policy === "fire_latest") {
    const latest = overdueOccurrences[overdueOccurrences.length - 1];
    for (const occurrence of overdueOccurrences) {
      if (latest !== undefined && occurrence.occurrenceKey === latest.occurrenceKey) eligible.add(occurrence.occurrenceKey);
      else missed.add(occurrence.occurrenceKey);
    }
  } else if (policy === "catch_up") {
    const requestedLimit = request.catchUpLimit ?? request.catch_up_limit ?? MAX_CATCH_UP_OCCURRENCES;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0 || requestedLimit > MAX_CATCH_UP_OCCURRENCES) {
      throw new OccurrenceCoreError("misfire_limit_exceeded", `catch-up limit must be between 1 and ${MAX_CATCH_UP_OCCURRENCES}`, { path: "catchUpLimit", details: { max: MAX_CATCH_UP_OCCURRENCES } });
    }
    overdueOccurrences.forEach((occurrence, index) => {
      if (index < requestedLimit) eligible.add(occurrence.occurrenceKey);
      else deferred.add(occurrence.occurrenceKey);
    });
  }
  const missedOccurrences = ordered.filter((occurrence) => missed.has(occurrence.occurrenceKey));
  const eligibleOccurrences = ordered.filter((occurrence) => eligible.has(occurrence.occurrenceKey));
  const deferredOccurrences = ordered.filter((occurrence) => deferred.has(occurrence.occurrenceKey));
  return {
    policy,
    now: new Date(nowMs).toISOString(),
    missed: missedOccurrences,
    eligible: eligibleOccurrences,
    deferred: deferredOccurrences,
    linked: linkedOccurrences,
    pending,
    decisions: decisionMap(ordered, linked, overdue, missed, eligible, deferred),
  };
}

export const classifyMisfire = classifyMisfires;
export const planMisfires = classifyMisfires;

function isActive(invocation: PriorInvocation): boolean {
  return invocation.invocationState === "invoked"
    || invocation.invocationState === "running"
    || invocation.status === "running";
}

/** Pure overlap policy decision. Suppression is deliberately not a misfire. */
export function decideOverlap(request: OverlapRequest): OverlapResult {
  const priorInvocations = request.priorInvocations ?? request.prior_invocations ?? [];
  if (request.policy === "allow") return { policy: request.policy, decision: "eligible", reason: "allow_policy", conflictingRunIds: [] };
  if (request.policy === "skip") return { policy: request.policy, decision: "suppressed", reason: "skip_policy", conflictingRunIds: [] };
  if (request.policy !== "fail_closed") throw new OccurrenceCoreError("invalid_overlap_policy", "unsupported overlap policy", { path: "policy" });
  const conflicts = priorInvocations
    .filter(isActive)
    .map((invocation) => invocation.runId)
    .sort();
  if (conflicts.length > 0) return { policy: request.policy, decision: "conflict", reason: "active_prior_invocation", conflictingRunIds: conflicts };
  return { policy: request.policy, decision: "eligible", reason: "no_active_prior_invocation", conflictingRunIds: [] };
}

export const evaluateOverlap = decideOverlap;
export const classifyOverlap = decideOverlap;
