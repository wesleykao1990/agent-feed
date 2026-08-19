import { canonicalJson, sha256Hex } from "./canonical.ts";
import { DELETABLE_RETENTION_ENTITIES, MAX_RETENTION_CANDIDATES, RETENTION_ENTITIES, type DeletableRetentionEntity, type JsonObject, type RetentionDeletionCandidate, type RetentionEntity, type RetentionExecution, type RetentionPlan, type RetentionPlanRequest, type RetentionRecord, type RetentionScope, type RetentionSkip, type RetentionStore } from "./types.ts";

const PLAN_SCHEMA_VERSION = "agent-feed.retention-plan.v1" as const;
const EXECUTION_SCHEMA_VERSION = "agent-feed.retention-execution.v1" as const;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function requireString(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid_${field}`);
}

function parseIso(value: string, field: string): number {
  requireString(value, field);
  if (!ISO_DATE_PATTERN.test(value)) throw new Error(`invalid_${field}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid_${field}`);
  return milliseconds;
}

function normalizeIso(value: string): string {
  return new Date(parseIso(value, "timestamp")).toISOString();
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_${field}`);
}

function assertScope(scope: RetentionScope): void {
  requireString(scope.tenantId, "tenant_id");
  for (const id of scope.runIds ?? []) requireString(id, "run_id");
  for (const id of scope.streamIds ?? []) requireString(id, "stream_id");
  for (const entity of scope.entities ?? []) {
    if (!RETENTION_ENTITIES.includes(entity)) throw new Error(`invalid_entity:${entity}`);
  }
}

function assertPolicy(request: RetentionPlanRequest): void {
  requireString(request.policy.policyVersion, "policy_version");
  assertPositiveInteger(request.policy.defaultRule.ageSeconds, "default_age_seconds");
  for (const [entity, rule] of Object.entries(request.policy.rules ?? {})) {
    if (!RETENTION_ENTITIES.includes(entity as RetentionEntity)) throw new Error(`invalid_entity:${entity}`);
    if (!rule) throw new Error(`invalid_rule:${entity}`);
    assertPositiveInteger(rule.ageSeconds, `${entity}_age_seconds`);
  }
}

function isEntity(value: string): value is RetentionEntity {
  return RETENTION_ENTITIES.includes(value as RetentionEntity);
}

function isDeletableEntity(value: string): value is DeletableRetentionEntity {
  return DELETABLE_RETENTION_ENTITIES.includes(value as DeletableRetentionEntity);
}

function isInScope(record: RetentionRecord, scope: RetentionScope): boolean {
  if (scope.runIds && (!record.runId || !scope.runIds.includes(record.runId))) return false;
  if (scope.streamIds && (!record.streamId || !scope.streamIds.includes(record.streamId))) return false;
  if (scope.entities && !scope.entities.includes(record.entity)) return false;
  return true;
}

function skip(record: RetentionRecord, reason: RetentionSkip["reason"]): RetentionSkip {
  return {
    tenantId: record.tenantId,
    entity: record.entity,
    id: record.id,
    reason,
  };
}

function planFingerprint(plan: Omit<RetentionPlan, "planId">): string {
  const value: JsonObject = {
    schema_version: plan.schemaVersion,
    policy_version: plan.policyVersion,
    generated_at: plan.generatedAt,
    scope: {
      tenant_id: plan.scope.tenantId,
      ...(plan.scope.runIds ? { run_ids: [...plan.scope.runIds].sort() } : {}),
      ...(plan.scope.streamIds ? { stream_ids: [...plan.scope.streamIds].sort() } : {}),
      ...(plan.scope.entities ? { entities: [...plan.scope.entities].sort() } : {}),
    },
    candidates: plan.candidates.map((candidate) => ({
      tenant_id: candidate.tenantId,
      entity: candidate.entity,
      id: candidate.id,
      run_id: candidate.runId,
      stream_id: candidate.streamId,
      eligible_at: candidate.eligibleAt,
      reason: candidate.reason,
    })),
    skipped: plan.skipped.map((item) => ({
      tenant_id: item.tenantId,
      entity: item.entity,
      id: item.id,
      reason: item.reason,
    })),
  };
  return sha256Hex(canonicalJson(value));
}

function compareCandidate(a: RetentionDeletionCandidate, b: RetentionDeletionCandidate): number {
  return a.eligibleAt.localeCompare(b.eligibleAt)
    || a.entity.localeCompare(b.entity)
    || a.id.localeCompare(b.id);
}

function compareSkip(a: RetentionSkip, b: RetentionSkip): number {
  return a.entity.localeCompare(b.entity) || a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason);
}

/**
 * Build a reviewable deletion plan without touching storage. The algorithm is
 * deliberately fail-closed: malformed records become skips, not deletes.
 */
export function planRetention(request: RetentionPlanRequest): RetentionPlan {
  assertScope(request.scope);
  assertPolicy(request);
  const nowMs = parseIso(request.now, "now");
  const generatedAt = new Date(nowMs).toISOString();
  const candidates: RetentionDeletionCandidate[] = [];
  const skipped: RetentionSkip[] = [];

  for (const record of request.records) {
    if (!record || typeof record !== "object") continue;
    if (record.tenantId !== request.scope.tenantId) {
      skipped.push(skip(record, "tenant_mismatch"));
      continue;
    }
    if (!isEntity(record.entity)) {
      skipped.push(skip(record, "unknown_entity"));
      continue;
    }
    if (!isInScope(record, request.scope)) {
      skipped.push(skip(record, "outside_scope"));
      continue;
    }
    try {
      requireString(record.id, "record_id");
      const createdMs = parseIso(record.createdAt, "created_at");
      const terminalMs = record.terminalAt === null ? null : parseIso(record.terminalAt, "terminal_at");
      const retainUntilMs = record.retainUntil === null ? null : parseIso(record.retainUntil, "retain_until");
      if (!isDeletableEntity(record.entity)) {
        skipped.push(skip(record, "protected_entity"));
        continue;
      }
      const rule = request.policy.rules?.[record.entity] ?? request.policy.defaultRule;
      const baseMs = terminalMs ?? createdMs;
      const eligibleMs = retainUntilMs ?? baseMs + rule.ageSeconds * 1000;
      if (record.legalHold) {
        skipped.push(skip(record, "legal_hold"));
      } else if (rule.requireTerminal && terminalMs === null) {
        skipped.push(skip(record, "not_terminal"));
      } else if (!Number.isFinite(eligibleMs)) {
        skipped.push(skip(record, "missing_retention_time"));
      } else if (nowMs < eligibleMs) {
        skipped.push(skip(record, "not_expired"));
      } else {
        if (candidates.length >= MAX_RETENTION_CANDIDATES) throw new Error("retention_candidate_limit_exceeded");
        candidates.push({
          tenantId: record.tenantId,
          entity: record.entity,
          id: record.id,
          runId: record.runId,
          streamId: record.streamId,
          eligibleAt: new Date(eligibleMs).toISOString(),
          reason: "expired",
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message === "retention_candidate_limit_exceeded") throw error;
      skipped.push(skip(record, "invalid_record"));
    }
  }

  candidates.sort(compareCandidate);
  skipped.sort(compareSkip);
  const withoutId: Omit<RetentionPlan, "planId"> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    policyVersion: request.policy.policyVersion,
    generatedAt,
    scope: {
      tenantId: request.scope.tenantId,
      ...(request.scope.runIds ? { runIds: [...request.scope.runIds].sort() } : {}),
      ...(request.scope.streamIds ? { streamIds: [...request.scope.streamIds].sort() } : {}),
      ...(request.scope.entities ? { entities: [...request.scope.entities].sort() } : {}),
    },
    candidates,
    skipped,
  };
  return { ...withoutId, planId: planFingerprint(withoutId) };
}

/**
 * Execute a plan through an adapter. Dry-run is the default and does not call
 * the adapter's delete method. The adapter still re-checks tenant, plan ID,
 * foreign-key dependencies, and legal holds transactionally.
 */
export async function executeRetentionPlan(
  store: RetentionStore,
  plan: RetentionPlan,
  options: { dryRun?: boolean } = {},
): Promise<RetentionExecution> {
  requireString(plan.planId, "plan_id");
  requireString(plan.scope.tenantId, "tenant_id");
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) throw new Error("invalid_plan_schema_version");
  if (plan.candidates.length > MAX_RETENTION_CANDIDATES) throw new Error("retention_candidate_limit_exceeded");
  const candidateKeys = new Set<string>();
  for (const candidate of plan.candidates) {
    if (!isDeletableEntity(candidate.entity)) throw new Error("retention_protected_entity");
    if (candidate.tenantId !== plan.scope.tenantId) throw new Error("retention_tenant_mismatch");
    requireString(candidate.id, "candidate_id");
    const key = `${candidate.entity}:${candidate.id}`;
    if (candidateKeys.has(key)) throw new Error("retention_duplicate_candidate");
    candidateKeys.add(key);
  }
  const { planId: suppliedPlanId, ...planWithoutId } = plan;
  const expectedPlanId = planFingerprint(planWithoutId);
  if (suppliedPlanId !== expectedPlanId) throw new Error("retention_plan_mismatch");
  const dryRun = options.dryRun ?? true;
  if (dryRun || plan.candidates.length === 0) {
    return {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      planId: plan.planId,
      dryRun,
      attempted: plan.candidates.length,
      deleted: 0,
      results: plan.candidates.map((candidate) => ({ entity: candidate.entity, id: candidate.id, deleted: false })),
    };
  }
  const results = await store.deleteRecords({
    tenantId: plan.scope.tenantId,
    planId: plan.planId,
    candidates: plan.candidates,
  });
  const deleted = results.filter((result) => result.deleted).length;
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    planId: plan.planId,
    dryRun: false,
    attempted: plan.candidates.length,
    deleted,
    results: [...results],
  };
}

/** Resolve records and build a plan in one adapter-neutral operation. */
export async function planRetentionFromStore(
  store: RetentionStore,
  request: Omit<RetentionPlanRequest, "records">,
): Promise<RetentionPlan> {
  const records = await store.listRecords(request.scope);
  return planRetention({ ...request, records });
}

export { canonicalJson, sha256Hex };
