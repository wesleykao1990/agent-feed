import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CATCH_UP_OCCURRENCES,
  MAX_MATERIALIZED_OCCURRENCES,
  classifyMisfires,
  decideOverlap,
  deriveInvocationOutcome,
  deterministicOccurrenceKey,
  matchInvocations,
  matchOccurrence,
  materializeOccurrences,
  normalizeExpectation,
  validateExpectation,
  type ExpectedOccurrence,
  type ScheduleExpectation,
} from "../src/index.ts";

const RANGE_FROM = "2026-01-01T00:00:00.000Z";
const RANGE_TO = "2026-01-01T06:00:00.000Z";

function expectation(overrides: Partial<ScheduleExpectation> = {}): ScheduleExpectation {
  return {
    schemaVersion: "agent-feed.occurrence-expectation.v1",
    expectationId: "job-a",
    expectationVersion: "v1",
    schedule: {
      kind: "interval",
      anchorAt: RANGE_FROM,
      intervalSeconds: 3_600,
    },
    graceSeconds: 60,
    matchingMode: "windowed",
    misfirePolicy: "mark_missed",
    overlapPolicy: "allow",
    enabled: true,
    ...overrides,
  };
}

function occurrences(overrides: Partial<ScheduleExpectation> = {}, from = RANGE_FROM, to = RANGE_TO): ExpectedOccurrence[] {
  return [...materializeOccurrences(expectation(overrides), { from, to }).occurrences];
}

function run(overrides: Partial<{
  runId: string;
  triggerKind: "scheduled" | "manual" | "test" | "retry" | "replay" | "backfill" | "event" | "unknown" | "legacy";
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  startedAt: string;
  occurrenceKey: string | null;
  expectationId: string | null;
  expectationVersion: string | null;
  findingsCount: number;
}> = {}) {
  return {
    runId: "run-a",
    triggerKind: "scheduled" as const,
    status: "completed" as const,
    startedAt: "2026-01-01T00:00:10.000Z",
    occurrenceKey: null,
    expectationId: "job-a",
    expectationVersion: "v1",
    findingsCount: 0,
    ...overrides,
  };
}

test("normalization is immutable, canonicalizes UTC, and validates IANA cron schedules", () => {
  const input = {
    expectation_id: "job-a",
    expectation_version: "v1",
    schedule: { kind: "interval" as const, anchor_at: "2026-01-01T09:00:00+09:00", interval_seconds: 3600 },
    grace_seconds: 30,
    matching_mode: "windowed" as const,
    misfire_policy: "mark_missed" as const,
    overlap_policy: "allow" as const,
  };
  const normalized = normalizeExpectation(input);
  assert.equal(normalized.schedule.kind, "interval");
  if (normalized.schedule.kind === "interval") assert.equal(normalized.schedule.anchorAt, RANGE_FROM);
  assert.equal(normalized.enabled, true);
  assert.equal(input.schedule.anchor_at, "2026-01-01T09:00:00+09:00");
  const cron = normalizeExpectation({
    ...input,
    schedule: { kind: "cron", expression: "0 9 1 * 1", timezone: "Asia/Tokyo" },
  });
  assert.equal(cron.schedule.kind, "cron");
});

test("validation reports structured errors for grammar, timezone, and policy violations", () => {
  const badCron = validateExpectation({
    expectationId: "job-a",
    expectationVersion: "v1",
    schedule: { kind: "cron", expression: "@daily", timezone: "Not/AZone" },
    graceSeconds: -1,
    matchingMode: "windowed",
    misfirePolicy: "mark_missed",
    overlapPolicy: "allow",
  });
  assert.equal(badCron.ok, false);
  if (!badCron.ok) {
    assert.equal(badCron.error.code, "invalid_timezone");
    assert.ok(badCron.issues.some((issue) => issue.code === "unsupported_cron_extension"));
    assert.ok(badCron.issues.some((issue) => issue.code === "invalid_grace_seconds"));
  }
  assert.throws(() => normalizeExpectation({
    expectationId: "job-a",
    expectationVersion: "v1",
    schedule: { kind: "cron", expression: "0 0 1 1", timezone: "UTC" },
    graceSeconds: 0,
    matchingMode: "windowed",
    misfirePolicy: "mark_missed",
    overlapPolicy: "allow",
  }), /exactly five fields/);
  for (const expression of ["0 0 * * ?", "0 0 * * 1#2", "0 0 * * 1L", "0 0 * * H"]) {
    assert.throws(() => normalizeExpectation({
      expectationId: "job-a",
      expectationVersion: "v1",
      schedule: { kind: "cron", expression, timezone: "UTC" },
      graceSeconds: 0,
      matchingMode: "windowed",
      misfirePolicy: "mark_missed",
      overlapPolicy: "allow",
    }), /extensions/);
  }
});

test("interval materialization uses immutable anchor cadence and a mandatory bounded limit", () => {
  const result = materializeOccurrences(expectation({ schedule: { kind: "interval", anchorAt: RANGE_FROM, intervalSeconds: 60 } }), {
    from: "2026-01-01T00:00:30Z",
    to: "2026-01-01T03:00:30Z",
  });
  assert.equal(result.occurrences[0]?.expectedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(result.occurrences[1]?.expectedAt, "2026-01-01T00:02:00.000Z");
  assert.equal(result.occurrences.at(-1)?.expectedAt, "2026-01-01T03:00:00.000Z");
  assert.throws(() => materializeOccurrences(expectation({ schedule: { kind: "interval", anchorAt: RANGE_FROM, intervalSeconds: 1 } }), {
    from: RANGE_FROM,
    to: "2026-01-01T02:46:41Z",
    limit: 10_001,
  }), /no greater than/);
  assert.throws(() => materializeOccurrences(expectation({ schedule: { kind: "interval", anchorAt: RANGE_FROM, intervalSeconds: 1 } }), {
    from: RANGE_FROM,
    to: "2026-01-01T02:46:41Z",
  }), /exceeds limit/);
  assert.equal(MAX_MATERIALIZED_OCCURRENCES, 10_000);
});

test("cron materialization is UTC-persisted and records cron-parser 5.10.0 DST behavior", () => {
  const spring = materializeOccurrences(expectation({
    schedule: { kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" },
  }), { from: "2026-03-08T00:00:00Z", to: "2026-03-09T12:00:00Z" }).occurrences;
  assert.deepEqual(spring.map((item) => item.expectedAt), ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  const fall = materializeOccurrences(expectation({
    schedule: { kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" },
  }), { from: "2026-11-01T00:00:00Z", to: "2026-11-02T12:00:00Z" }).occurrences;
  // cron-parser 5.10.0 emits the first 01:30 wall-clock occurrence on the
  // repeated fall-back hour, not a second duplicate at the later offset.
  assert.deepEqual(fall.map((item) => item.expectedAt), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

test("occurrence keys are deterministic and version/time scoped", () => {
  const first = deterministicOccurrenceKey("job-a", "v1", RANGE_FROM);
  assert.equal(first, deterministicOccurrenceKey("job-a", "v1", "2026-01-01T09:00:00+09:00"));
  assert.notEqual(first, deterministicOccurrenceKey("job-a", "v2", RANGE_FROM));
  assert.notEqual(first, deterministicOccurrenceKey("job-b", "v1", RANGE_FROM));
});

test("matching enforces trigger matrix, explicit identity, and one-run/one-occurrence", () => {
  const exp = expectation({ matchingMode: "explicit" });
  const expected = occurrences({ matchingMode: "explicit" });
  const target = expected[1];
  assert.ok(target);
  const matched = matchOccurrence({ expectation: exp, run: run({ occurrenceKey: target.occurrenceKey, startedAt: "2026-01-01T00:00:10Z" }), occurrences: expected });
  assert.equal(matched.matched, true);
  assert.equal(matched.derivedOutcome.outcome, "successful_completed");
  assert.equal(matched.derivedOutcome.findingsCount, 0);
  const noKey = matchOccurrence({ expectation: exp, run: run({ occurrenceKey: null }), occurrences: expected });
  assert.equal(noKey.reason, "missing_explicit_occurrence");
  const duplicate = matchOccurrence({ expectation: exp, run: run({ occurrenceKey: target.occurrenceKey }), occurrences: [target, target] });
  assert.equal(duplicate.reason, "duplicate_occurrence_key");
  for (const triggerKind of ["manual", "test", "retry", "replay", "backfill", "event", "unknown", "legacy"] as const) {
    const rejected = matchOccurrence({ expectation: expectation(), run: run({ triggerKind }), occurrences: occurrences() });
    assert.equal(rejected.matched, false);
    assert.equal(rejected.reason, "unsupported_trigger");
  }
  const legacy = matchOccurrence({
    expectation: expectation({ matchingMode: "legacy" }),
    run: run({ triggerKind: "legacy" }),
    occurrences: occurrences({ matchingMode: "legacy" }),
  });
  assert.equal(legacy.matched, true);
});

test("windowed matching requires exactly one candidate and uses an inclusive grace window", () => {
  const exp = expectation({ graceSeconds: 3_660 });
  const expected = occurrences({ graceSeconds: 3_660 });
  const one = matchOccurrence({ expectation: exp, run: run({ startedAt: "2026-01-01T01:01:01Z" }), occurrences: expected });
  assert.equal(one.matched, true);
  const many = matchOccurrence({ expectation: exp, run: run({ startedAt: "2026-01-01T01:00:30Z" }), occurrences: expected });
  assert.equal(many.reason, "ambiguous_window");
  const narrowExp = expectation();
  const narrowExpected = occurrences();
  const outside = matchOccurrence({ expectation: narrowExp, run: run({ startedAt: "2026-01-01T01:01:01Z" }), occurrences: narrowExpected });
  assert.equal(outside.reason, "outside_window");
  const linked = matchOccurrence({ expectation: exp, run: run(), occurrences: expected, linkedOccurrenceKeys: [expected[0]?.occurrenceKey ?? ""] });
  assert.equal(linked.reason, "already_linked");
});

test("derived outcomes distinguish invocation failure, running, cancellation, partial, completion, and absence", () => {
  assert.equal(deriveInvocationOutcome(null).outcome, "absence");
  assert.equal(deriveInvocationOutcome(run({ status: "running" })).outcome, "running_invocation");
  assert.equal(deriveInvocationOutcome(run({ status: "completed", findingsCount: 0 })).outcome, "successful_completed");
  assert.equal(deriveInvocationOutcome(run({ status: "partial" })).outcome, "partial");
  assert.equal(deriveInvocationOutcome(run({ status: "failed" })).outcome, "failed");
  assert.equal(deriveInvocationOutcome(run({ status: "cancelled" })).outcome, "cancelled");
  assert.equal(deriveInvocationOutcome(run(), false).outcome, "absence");
});

test("misfire policies are deterministic and preserve explicit deferred/linked states", () => {
  const expected = occurrences({}, RANGE_FROM, "2026-01-01T04:00:00Z");
  const now = "2026-01-01T04:02:00Z";
  const marked = classifyMisfires({ policy: "mark_missed", occurrences: expected, now, linkedOccurrenceKeys: [expected[0]?.occurrenceKey ?? ""] });
  assert.equal(marked.missed.length, expected.length - 1);
  assert.equal(marked.linked.length, 1);
  const latest = classifyMisfires({ policy: "fire_latest", occurrences: expected, now });
  assert.equal(latest.eligible.length, 1);
  assert.equal(latest.eligible[0]?.expectedAt, "2026-01-01T04:00:00.000Z");
  assert.equal(latest.missed.length, expected.length - 1);
  const catchUp = classifyMisfires({ policy: "catch_up", occurrences: expected, now, catchUpLimit: 2 });
  assert.deepEqual(catchUp.eligible.map((item) => item.expectedAt), [RANGE_FROM, "2026-01-01T01:00:00.000Z"]);
  assert.equal(catchUp.deferred.length, expected.length - 2);
  assert.throws(() => classifyMisfires({ policy: "catch_up", occurrences: expected, now, catchUpLimit: MAX_CATCH_UP_OCCURRENCES + 1 }), /between 1 and 100/);
});

test("overlap policies are pure and fail closed on active prior invocations", () => {
  assert.deepEqual(decideOverlap({ policy: "allow", priorInvocations: [{ runId: "r", status: "running" }] }).decision, "eligible");
  assert.deepEqual(decideOverlap({ policy: "skip", priorInvocations: [{ runId: "r", status: "running" }] }).decision, "suppressed");
  const conflict = decideOverlap({ policy: "fail_closed", priorInvocations: [{ runId: "r", status: "running" }, { runId: "done", status: "completed" }] });
  assert.equal(conflict.decision, "conflict");
  assert.deepEqual(conflict.conflictingRunIds, ["r"]);
  assert.equal(decideOverlap({ policy: "fail_closed", priorInvocations: [{ runId: "done", status: "completed" }] }).decision, "eligible");
});

test("batch matching rejects duplicate run IDs and cannot link one run to two occurrences", () => {
  const exp = expectation({ matchingMode: "explicit" });
  const expected = occurrences({ matchingMode: "explicit" });
  const key = expected[0]?.occurrenceKey;
  assert.ok(key);
  const results = matchInvocations({ expectation: exp, occurrences: expected, runs: [run({ occurrenceKey: key }), run({ occurrenceKey: key })] });
  assert.equal(results[0]?.matched, true);
  assert.equal(results[1]?.matched, false);
  assert.equal(results[1]?.reason, "already_linked");
});
