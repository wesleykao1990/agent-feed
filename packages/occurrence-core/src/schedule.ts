import { CronExpressionParser } from "cron-parser";
import {
  EXPECTED_OCCURRENCE_SCHEMA_VERSION,
  MAX_MATERIALIZED_OCCURRENCES,
  OccurrenceCoreError,
  type ExpectedOccurrence,
  type MaterializeOccurrencesRequest,
  type OccurrenceMaterialization,
  type OccurrenceRange,
  type ScheduleExpectation,
  type ScheduleExpectationInput,
} from "./types.ts";
import { normalizeExpectation, normalizeUtcInstant, parseUtcInstant } from "./validation.ts";
import { sha256Hex } from "./stable.ts";

function canonicalUtc(value: string, path: string): string {
  const issues: { code: string; path: string; message: string }[] = [];
  const normalized = normalizeUtcInstant(value, path, issues);
  if (normalized === undefined) {
    throw new OccurrenceCoreError("invalid_timestamp", issues[0]?.message ?? `invalid ${path}`, { path });
  }
  return normalized;
}

function assertRange(from: string, to: string): { from: string; to: string; fromMs: number; toMs: number } {
  const normalizedFrom = canonicalUtc(from, "from");
  const normalizedTo = canonicalUtc(to, "to");
  const fromMs = parseUtcInstant(normalizedFrom, "from");
  const toMs = parseUtcInstant(normalizedTo, "to");
  if (fromMs > toMs) throw new OccurrenceCoreError("invalid_range", "from must be less than or equal to to", { path: "range" });
  return { from: normalizedFrom, to: normalizedTo, fromMs, toMs };
}

function assertLimit(limit: number | undefined): number {
  const effective = limit ?? MAX_MATERIALIZED_OCCURRENCES;
  if (!Number.isSafeInteger(effective) || effective <= 0 || effective > MAX_MATERIALIZED_OCCURRENCES) {
    throw new OccurrenceCoreError("invalid_limit", `limit must be a positive integer no greater than ${MAX_MATERIALIZED_OCCURRENCES}`, { path: "limit" });
  }
  return effective;
}

/**
 * Stable occurrence identity. The key includes the immutable expectation ID,
 * immutable expectation version, and canonical nominal UTC instant. A cadence
 * change therefore cannot silently reuse an old occurrence key.
 */
export function deterministicOccurrenceKey(expectationId: string, expectationVersion: string, nominalAt: string): string {
  if (typeof expectationId !== "string" || expectationId.length === 0) throw new OccurrenceCoreError("invalid_expectation", "expectationId is required", { path: "expectationId" });
  if (typeof expectationVersion !== "string" || expectationVersion.length === 0) throw new OccurrenceCoreError("invalid_expectation", "expectationVersion is required", { path: "expectationVersion" });
  const canonicalNominalAt = canonicalUtc(nominalAt, "nominalAt");
  return `occ_${sha256Hex(JSON.stringify([expectationId, expectationVersion, canonicalNominalAt]))}`;
}

export const occurrenceKey = deterministicOccurrenceKey;
export const deriveOccurrenceKey = deterministicOccurrenceKey;

function createOccurrence(expectation: ScheduleExpectation, expectedAt: string): ExpectedOccurrence {
  const normalizedExpectedAt = canonicalUtc(expectedAt, "expectedAt");
  const expectedMs = parseUtcInstant(normalizedExpectedAt, "expectedAt");
  const windowEndMs = expectedMs + expectation.graceSeconds * 1000;
  if (!Number.isSafeInteger(windowEndMs) || windowEndMs > 8_640_000_000_000_000 || windowEndMs < -8_640_000_000_000_000) {
    throw new OccurrenceCoreError("invalid_range", "occurrence grace window exceeds the representable UTC range", { path: "graceSeconds" });
  }
  const windowEndsAt = new Date(windowEndMs).toISOString();
  const occurrenceKeyValue = deterministicOccurrenceKey(expectation.expectationId, expectation.expectationVersion, normalizedExpectedAt);
  return {
    schemaVersion: EXPECTED_OCCURRENCE_SCHEMA_VERSION,
    occurrenceKey: occurrenceKeyValue,
    expectationId: expectation.expectationId,
    expectationVersion: expectation.expectationVersion,
    expectedAt: normalizedExpectedAt,
    nominalAt: normalizedExpectedAt,
    windowEndsAt,
    graceSeconds: expectation.graceSeconds,
  };
}

function materializeInterval(expectation: ScheduleExpectation, fromMs: number, toMs: number, limit: number): ExpectedOccurrence[] {
  if (expectation.schedule.kind !== "interval") return [];
  const anchorMs = parseUtcInstant(expectation.schedule.anchorAt, "schedule.anchorAt");
  const periodMs = expectation.schedule.intervalSeconds * 1000;
  // Number arithmetic is exact for the valid Date range and all practical
  // interval periods. Reject impossible huge multiplication rather than drift.
  if (!Number.isSafeInteger(periodMs) || periodMs <= 0) throw new OccurrenceCoreError("invalid_schedule", "interval period is outside the representable UTC range", { path: "schedule.intervalSeconds" });
  const firstIndex = Math.max(0, Math.ceil((fromMs - anchorMs) / periodMs));
  const firstMs = anchorMs + firstIndex * periodMs;
  if (!Number.isSafeInteger(firstMs)) return [];
  if (firstMs > toMs) return [];
  const count = Math.floor((toMs - firstMs) / periodMs) + 1;
  if (!Number.isSafeInteger(count) || count > limit) {
    throw new OccurrenceCoreError("occurrence_limit_exceeded", `materialization exceeds limit ${limit}`, { path: "limit", details: { limit } });
  }
  const occurrences: ExpectedOccurrence[] = [];
  for (let index = 0; index < count; index += 1) {
    const nominalMs = firstMs + index * periodMs;
    if (!Number.isSafeInteger(nominalMs)) throw new OccurrenceCoreError("occurrence_limit_exceeded", "interval materialization exceeded UTC bounds", { path: "range" });
    occurrences.push(createOccurrence(expectation, new Date(nominalMs).toISOString()));
  }
  return occurrences;
}

function materializeCron(expectation: ScheduleExpectation, fromMs: number, toMs: number, limit: number): ExpectedOccurrence[] {
  if (expectation.schedule.kind !== "cron") return [];
  // Five-field expressions have minute precision. Subtract one millisecond so
  // an occurrence exactly at `from` is included despite cron-parser's strict
  // next-after-currentDate iterator semantics.
  const currentMs = fromMs <= -8_640_000_000_000_000 ? fromMs : fromMs - 1;
  const expression = CronExpressionParser.parse(expectation.schedule.expression, {
    tz: expectation.schedule.timezone,
    strict: false,
    currentDate: new Date(currentMs),
    endDate: new Date(toMs),
  });
  const occurrences: ExpectedOccurrence[] = [];
  for (;;) {
    let nextMs: number;
    try {
      nextMs = expression.next().getTime();
    } catch (error) {
      // cron-parser reports this when no next instant is inside endDate. That
      // is normal range exhaustion, not a malformed schedule.
      if (error instanceof Error && /time span|out of the time span|range/i.test(error.message)) break;
      throw new OccurrenceCoreError("invalid_cron_expression", error instanceof Error ? error.message : "cron-parser failed while iterating", { path: "schedule.expression" });
    }
    if (!Number.isFinite(nextMs) || nextMs > toMs) break;
    if (nextMs < fromMs) continue;
    if (occurrences.length >= limit) {
      throw new OccurrenceCoreError("occurrence_limit_exceeded", `materialization exceeds limit ${limit}`, { path: "limit", details: { limit } });
    }
    occurrences.push(createOccurrence(expectation, new Date(nextMs).toISOString()));
  }
  return occurrences;
}

export function materializeOccurrences(request: MaterializeOccurrencesRequest): OccurrenceMaterialization;
export function materializeOccurrences(expectation: ScheduleExpectation | ScheduleExpectationInput, range: OccurrenceRange): OccurrenceMaterialization;
export function materializeOccurrences(
  requestOrExpectation: MaterializeOccurrencesRequest | ScheduleExpectation | ScheduleExpectationInput,
  maybeRange?: OccurrenceRange,
): OccurrenceMaterialization {
  const request: MaterializeOccurrencesRequest = maybeRange === undefined
    ? requestOrExpectation as MaterializeOccurrencesRequest
    : {
      expectation: requestOrExpectation as ScheduleExpectation | ScheduleExpectationInput,
      from: maybeRange.from,
      to: maybeRange.to,
      ...(maybeRange.limit === undefined ? {} : { limit: maybeRange.limit }),
    };
  const expectation = normalizeExpectation(request.expectation);
  const limit = assertLimit(request.limit);
  if (!expectation.enabled) {
    const range = assertRange(request.from, request.to);
    return { expectation, from: range.from, to: range.to, occurrences: [] };
  }
  const range = assertRange(request.from, request.to);
  const occurrences = expectation.schedule.kind === "interval"
    ? materializeInterval(expectation, range.fromMs, range.toMs, limit)
    : materializeCron(expectation, range.fromMs, range.toMs, limit);
  return { expectation, from: range.from, to: range.to, occurrences };
}

export const generateOccurrences = materializeOccurrences;
export const materializeExpectedOccurrences = materializeOccurrences;

/** Convenience adapter-facing view when only the occurrence list is needed. */
export function materializeOccurrenceList(
  requestOrExpectation: MaterializeOccurrencesRequest | ScheduleExpectation | ScheduleExpectationInput,
  maybeRange?: OccurrenceRange,
): readonly ExpectedOccurrence[] {
  return maybeRange === undefined
    ? materializeOccurrences(requestOrExpectation as MaterializeOccurrencesRequest).occurrences
    : materializeOccurrences(requestOrExpectation as ScheduleExpectation | ScheduleExpectationInput, maybeRange).occurrences;
}
