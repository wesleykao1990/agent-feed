import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  JOB_REGISTRY_MIGRATION_SQL_URL,
  PersistenceError,
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
  type BeginRunRequest,
  type SubmitAssessmentInput,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("job-registry migration is additive, immutable, tenant-scoped, and fail-closed", async () => {
  const sql = await readFile(JOB_REGISTRY_MIGRATION_SQL_URL, "utf8");
  for (const marker of [
    "job_definition_versions", "capability_profile_versions", "job_deployment_binding_versions",
    "protect_job_registry_row", "registry_json_is_safe", "registry_reference_is_safe",
    "validate_job_definition_version", "validate_capability_profile_version",
    "validate_job_deployment_binding", "m9_version_at_least", "0006_job_registry",
    "successful shadow evidence", "assessment_receipt_seals", "assessor_independence = 'independent'",
  ]) assert.match(sql, new RegExp(marker.replaceAll(".", "\\."), "i"), marker);
  assert.match(sql, /foreign key \(tenant_id, job_definition_version_id\)/i);
  assert.match(sql, /before update or delete on agent_feed\.job_definition_versions/i);
  assert.doesNotMatch(sql, /alter\s+table\s+agent_feed\.runs\s+add\s+column/iu);
});

function begin(tenantId: string): BeginRunRequest {
  return {
    protocol_version: "0.1", tenant_id: tenantId, idempotency_key: `m9-begin-${randomUUID()}`,
    stream_id: `m9-${randomUUID()}`, producer: { producer_id: "m9-test", type: "automation", name: "m9", version: "1" },
    task: { task_type: "m9-shadow", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-20T00:00:00.000Z", parent_run_id: null, metadata: {}, run_id: `m9-wire-${randomUUID()}`,
  };
}

function assessment(runId: string, policyId: string): SubmitAssessmentInput {
  return {
    tenant_id: "m9-tenant", run_id: runId, policy_version_id: policyId,
    request_idempotency_key: `m9-assess-${randomUUID()}`, assessment_kind: "quality", verdict: "passed",
    failure_stage: "none", failure_class: "none", stop_reason: "completed", summary: "shadow passed",
    usage_observations: [{ metric: "wall_time_ms", state: "unknown", value: null, provenance: "unknown" }],
  };
}

test("live PostgreSQL registry preserves portable history and blocks unsafe activation", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live PostgreSQL gate not executed" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    await migrateAgentFeed(pool);
    const store = new PostgresAgentFeedPersistence(pool);
    const policy = await store.createValidationPolicyVersion({
      tenant_id: "m9-tenant", policy_key: `m9-quality-${randomUUID()}`,
      policy: { schemaVersion: "agent-feed.validation-policy.v1", policyKey: null, policyVersion: null, requiredAssessmentKinds: ["quality"], minimumIndependence: "independent", declaredBudgetRequirement: "optional", metadata: {} },
    });
    const assessor = await store.registerTrustedAssessorVersion({
      tenant_id: "m9-tenant", assessor_id: `m9-assessor-${randomUUID()}`, assessor_type: "validation_service",
      independence: "independent", subject_digest: HASH,
    });
    const run = await store.beginRun(begin("m9-tenant"));
    const proof = await store.submitAssessment(assessment(run.run_id, policy.id), {
      tenant_id: "m9-tenant", assessor_registration_version_id: assessor.id,
    });
    const definition = await store.jobRegistry.createJobDefinitionVersion({
      tenant_id: "m9-tenant",
      definition: {
        jobKey: `portable-job-${randomUUID()}`, version: 1, ownerId: "owner-team", lifecycleState: "active",
        instructions: { digest: HASH, controlledReference: "git+https://example.test/repo@abc123/prompt.md" },
        validationPolicyVersionId: policy.id,
        requiredCapabilities: [{ key: "scheduled_invocation", minimumVersion: "1.2", role: "scheduler" }],
        outputContracts: [{ contractKey: "finding-bundle", version: "1", sha256: HASH }],
        budgets: [{ budgetKey: "tokens", limit: 1000, unit: "tokens" }], metadata: {},
      },
    });
    const scheduler = await store.jobRegistry.createCapabilityProfileVersion({ tenant_id: "m9-tenant", profile: {
      profileKey: `scheduler-a-${randomUUID()}`, version: 1, providerKey: "provider-a",
      capabilities: [{ key: "scheduled_invocation", version: "1.3", role: "scheduler", available: true }],
    } });
    const executor = await store.jobRegistry.createCapabilityProfileVersion({ tenant_id: "m9-tenant", profile: {
      profileKey: `executor-b-${randomUUID()}`, version: 1, providerKey: "provider-b", capabilities: [],
    } });
    const first = await store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: "m9-tenant", binding_key: `portable-prod-${randomUUID()}`, version: 1,
      job_definition_version_id: definition.id, activation_state: "active",
      topology: { schedulerProvider: "provider-a", executorProvider: "provider-b", ingressKind: "mcp" },
      capability_profile_version_ids: [scheduler.id, executor.id],
      off_switch_reference: "config://agent-feed/off-switch/portable-job", shadow_assessment_ids: [proof.id],
    });
    assert.equal(first.preflight.compatible, true);
    assert.equal(first.job_definition_version_id, definition.id);

    const schedulerMoved = await store.jobRegistry.createCapabilityProfileVersion({ tenant_id: "m9-tenant", profile: {
      profileKey: `scheduler-c-${randomUUID()}`, version: 1, providerKey: "provider-c",
      capabilities: [{ key: "scheduled_invocation", version: "2", role: "scheduler", available: true }],
    } });
    const executorMoved = await store.jobRegistry.createCapabilityProfileVersion({ tenant_id: "m9-tenant", profile: {
      profileKey: `executor-d-${randomUUID()}`, version: 1, providerKey: "provider-d", capabilities: [],
    } });
    const moved = await store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: "m9-tenant", binding_key: first.binding_key, version: 2,
      job_definition_version_id: definition.id, activation_state: "active",
      topology: { schedulerProvider: "provider-c", executorProvider: "provider-d", ingressKind: "rest" },
      capability_profile_version_ids: [schedulerMoved.id, executorMoved.id],
      off_switch_reference: "config://agent-feed/off-switch/portable-job", shadow_assessment_ids: [proof.id],
    });
    assert.equal(moved.job_definition_version_id, definition.id, "provider move must preserve logical job version identity");
    assert.equal((await store.jobRegistry.listDeploymentBindingVersions({ tenant_id: "m9-tenant", binding_key: first.binding_key })).length, 2);

    const insufficient = await store.jobRegistry.createCapabilityProfileVersion({ tenant_id: "m9-tenant", profile: {
      profileKey: `scheduler-old-${randomUUID()}`, version: 1, providerKey: "provider-a",
      capabilities: [{ key: "scheduled_invocation", version: "1.1", role: "scheduler", available: true }],
    } });
    await assert.rejects(store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: "m9-tenant", binding_key: `bad-${randomUUID()}`, version: 1,
      job_definition_version_id: definition.id, activation_state: "active",
      topology: { schedulerProvider: "provider-a", executorProvider: "provider-b", ingressKind: "mcp" },
      capability_profile_version_ids: [insufficient.id, executor.id], off_switch_reference: "config://agent-feed/off-switch/bad",
      shadow_assessment_ids: [proof.id],
    }), (error: unknown) => error instanceof PersistenceError && error.code === "job_registry_preflight_failed");

    await assert.rejects(pool.query("update agent_feed.job_definition_versions set owner_id = 'tampered' where id = $1", [definition.id]), /append-only/i);
    await assert.rejects(pool.query("delete from agent_feed.capability_profile_versions where id = $1", [scheduler.id]), /append-only/i);
    await assert.rejects(pool.query(
      `with changed as (
        select jsonb_set(jsonb_set(definition_json, '{jobKey}', to_jsonb($2::text)), '{budgets}', '[{}]'::jsonb) payload
          from agent_feed.job_definition_versions where id = $1
      ) insert into agent_feed.job_definition_versions (
        id, tenant_id, job_key, version, owner_id, lifecycle_state, instruction_digest, instruction_reference,
        validation_policy_version_id, required_capabilities, output_contracts, budgets, definition_json,
        definition_canonical_json, definition_hash, metadata
      ) select gen_random_uuid(), 'm9-tenant', $2, 1, 'owner-team', 'active', $3,
        'git+https://example.test/repo@abc123/prompt.md', $4, payload->'requiredCapabilities',
        payload->'outputContracts', payload->'budgets', payload, payload::text,
        encode(digest(convert_to(payload::text, 'utf8'), 'sha256'), 'hex'), '{}'::jsonb from changed`,
      [definition.id, `malformed-budget-${randomUUID()}`, HASH, policy.id],
    ), /contract structure|budget/i);
    const shadowOnly = await store.jobRegistry.createDeploymentBindingVersion({
      tenant_id: "m9-tenant", binding_key: `shadow-only-${randomUUID()}`, version: 1,
      job_definition_version_id: definition.id, activation_state: "shadow",
      topology: { schedulerProvider: "provider-a", executorProvider: "provider-b", ingressKind: "mcp" },
      capability_profile_version_ids: [scheduler.id, executor.id], off_switch_reference: null, shadow_assessment_ids: [],
    });
    await assert.rejects(pool.query(
      `insert into agent_feed.job_deployment_binding_versions (
        id, tenant_id, binding_key, version, job_definition_version_id, activation_state,
        scheduler_provider, executor_provider, ingress_kind, capability_profile_version_ids,
        off_switch_reference, shadow_assessment_ids, preflight_json, binding_json, binding_canonical_json, binding_hash, metadata
      ) select gen_random_uuid(), tenant_id, $2, version, job_definition_version_id, 'active', scheduler_provider,
        executor_provider, ingress_kind, capability_profile_version_ids, off_switch_reference, '{}'::uuid[],
        jsonb_set(jsonb_set(preflight_json, '{compatible}', 'true'::jsonb), '{reasons}', '["compatible"]'::jsonb),
        jsonb_set(jsonb_set(binding_json, '{bindingKey}', to_jsonb($2::text)), '{activationState}', '"active"'::jsonb),
        replace(replace(binding_canonical_json, binding_key, $2), '"activationState":"shadow"', '"activationState":"active"'),
        encode(digest(convert_to(replace(replace(binding_canonical_json, binding_key, $2), '"activationState":"shadow"', '"activationState":"active"'), 'utf8'), 'sha256'), 'hex'), metadata
      from agent_feed.job_deployment_binding_versions where id = $1`, [shadowOnly.id, `direct-no-shadow-${randomUUID()}`]), /off-switch|shadow evidence/i);
    assert.equal(await store.jobRegistry.getJobDefinitionVersion("other-tenant", definition.id), null);
  } finally { await pool.end(); }
});
