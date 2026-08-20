import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  canonicalJson,
  evaluateActivationPreflight,
  hashCapabilityProfile,
  hashJobDefinition,
  normalizeCapabilityProfile,
  normalizeDeploymentBinding,
  normalizeJobDefinition,
  sha256Hex,
  type ActivationPreflight,
  type CapabilityProfile,
  type JobDefinition,
  type JsonValue as CoreJsonValue,
} from "@agent-feed/job-registry-core";
import { PersistenceError } from "./errors.ts";
import type {
  CapabilityProfileVersion,
  CapabilityProfileVersionInput,
  JobDefinitionVersion,
  JobDefinitionVersionInput,
  JobDeploymentBindingVersion,
  JobDeploymentBindingVersionInput,
  JobRegistryListOptions,
  JsonObject,
} from "./types.ts";

interface DefinitionRow extends QueryResultRow {
  id: string; tenant_id: string; definition_json: JobDefinition; definition_hash: string;
  metadata: JsonObject; created_at: Date | string;
}
interface ProfileRow extends QueryResultRow {
  id: string; tenant_id: string; profile_json: CapabilityProfile; profile_hash: string;
  metadata: JsonObject; created_at: Date | string;
}
interface BindingRow extends QueryResultRow {
  id: string; tenant_id: string; binding_key: string; version: number | string;
  job_definition_version_id: string; activation_state: JobDeploymentBindingVersion["activation_state"];
  scheduler_provider: string; executor_provider: string; ingress_kind: JobDeploymentBindingVersion["topology"]["ingressKind"];
  capability_profile_version_ids: string[]; off_switch_reference: string | null;
  shadow_assessment_ids: string[]; preflight_json: ActivationPreflight; binding_hash: string;
  metadata: JsonObject; created_at: Date | string;
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function integer(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new PersistenceError("storage_error", "database returned an invalid registry version");
  return result;
}
function json(value: unknown): string { return JSON.stringify(value); }
function mapError(error: unknown): never {
  if (error instanceof PersistenceError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint: unknown }).constraint) : "";
  const message = error instanceof Error ? error.message : "job registry persistence failed";
  if (code === "23505") throw new PersistenceError("job_registry_version_conflict", "immutable registry version already exists", { constraint });
  if (["23503", "23514", "22P02", "P0001"].includes(code)) throw new PersistenceError("job_registry_validation_failed", message, { constraint });
  throw new PersistenceError("storage_error", "job registry database operation failed");
}

function mapDefinition(row: DefinitionRow): JobDefinitionVersion {
  return { id: row.id, tenant_id: row.tenant_id, definition: row.definition_json, definition_hash: row.definition_hash, metadata: row.metadata, created_at: iso(row.created_at) };
}
function mapProfile(row: ProfileRow): CapabilityProfileVersion {
  return { id: row.id, tenant_id: row.tenant_id, profile: row.profile_json, profile_hash: row.profile_hash, metadata: row.metadata, created_at: iso(row.created_at) };
}
function mapBinding(row: BindingRow): JobDeploymentBindingVersion {
  return {
    id: row.id, tenant_id: row.tenant_id, binding_key: row.binding_key, version: integer(row.version),
    job_definition_version_id: row.job_definition_version_id, activation_state: row.activation_state,
    topology: { schedulerProvider: row.scheduler_provider, executorProvider: row.executor_provider, ingressKind: row.ingress_kind },
    capability_profile_version_ids: row.capability_profile_version_ids, off_switch_reference: row.off_switch_reference,
    shadow_assessment_ids: row.shadow_assessment_ids, preflight: row.preflight_json, binding_hash: row.binding_hash,
    metadata: row.metadata, created_at: iso(row.created_at),
  };
}

export class PostgresJobRegistryRepository {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async createJobDefinitionVersion(input: JobDefinitionVersionInput): Promise<JobDefinitionVersion> {
    const tenantId = input.tenant_id ?? "default";
    const definition = normalizeJobDefinition(input.definition);
    const canonical = canonicalJson(definition as unknown as CoreJsonValue);
    const hash = hashJobDefinition(definition);
    try {
      const result = await this.pool.query<DefinitionRow>(
        `insert into agent_feed.job_definition_versions (
           id, tenant_id, job_key, version, owner_id, lifecycle_state, instruction_digest, instruction_reference,
           validation_policy_version_id, required_capabilities, output_contracts, budgets, definition_json,
           definition_canonical_json, definition_hash, metadata
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16::jsonb)
         returning id, tenant_id, definition_json, definition_hash, metadata, created_at`,
        [randomUUID(), tenantId, definition.jobKey, definition.version, definition.ownerId, definition.lifecycleState,
          definition.instructions.digest, definition.instructions.controlledReference, definition.validationPolicyVersionId,
          json(definition.requiredCapabilities), json(definition.outputContracts), json(definition.budgets), json(definition),
          canonical, hash, json(input.metadata ?? {})],
      );
      return mapDefinition(result.rows[0]!);
    } catch (error) { return mapError(error); }
  }

  async createCapabilityProfileVersion(input: CapabilityProfileVersionInput): Promise<CapabilityProfileVersion> {
    const tenantId = input.tenant_id ?? "default";
    const profile = normalizeCapabilityProfile(input.profile);
    const canonical = canonicalJson(profile as unknown as CoreJsonValue);
    const hash = hashCapabilityProfile(profile);
    try {
      const result = await this.pool.query<ProfileRow>(
        `insert into agent_feed.capability_profile_versions (
           id, tenant_id, profile_key, version, provider_key, capabilities, profile_json,
           profile_canonical_json, profile_hash, metadata
         ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb)
         returning id, tenant_id, profile_json, profile_hash, metadata, created_at`,
        [randomUUID(), tenantId, profile.profileKey, profile.version, profile.providerKey, json(profile.capabilities),
          json(profile), canonical, hash, json(input.metadata ?? {})],
      );
      return mapProfile(result.rows[0]!);
    } catch (error) { return mapError(error); }
  }

  async createDeploymentBindingVersion(input: JobDeploymentBindingVersionInput): Promise<JobDeploymentBindingVersion> {
    const tenantId = input.tenant_id ?? "default";
    try {
      const definitionResult = await this.pool.query<DefinitionRow>(
        "select id, tenant_id, definition_json, definition_hash, metadata, created_at from agent_feed.job_definition_versions where tenant_id = $1 and id = $2",
        [tenantId, input.job_definition_version_id],
      );
      const definitionRow = definitionResult.rows[0];
      if (!definitionRow) throw new PersistenceError("job_definition_version_not_found", "job definition version was not found");
      const profileResult = input.capability_profile_version_ids.length === 0
        ? { rows: [] as ProfileRow[] }
        : await this.pool.query<ProfileRow>(
          "select id, tenant_id, profile_json, profile_hash, metadata, created_at from agent_feed.capability_profile_versions where tenant_id = $1 and id = any($2::uuid[]) order by id",
          [tenantId, input.capability_profile_version_ids],
        );
      if (profileResult.rows.length !== new Set(input.capability_profile_version_ids).size) {
        throw new PersistenceError("capability_profile_version_not_found", "one or more capability profile versions were not found");
      }
      const shadowIds = input.shadow_assessment_ids ?? [];
      const assessmentResult = shadowIds.length === 0 ? { rows: [] as { id: string }[] } : await this.pool.query<{ id: string }>(
        `select a.id from agent_feed.run_assessments a
          join agent_feed.assessment_receipt_seals seal on seal.tenant_id = a.tenant_id and seal.assessment_id = a.id
         where a.tenant_id = $1 and a.id = any($2::uuid[]) and a.verdict = 'passed' and a.assessor_independence = 'independent'`,
        [tenantId, shadowIds],
      );
      if (assessmentResult.rows.length !== new Set(shadowIds).size) {
        throw new PersistenceError("job_registry_validation_failed", "shadow evidence must be sealed, passed, and independent");
      }
      const binding = normalizeDeploymentBinding({
        bindingKey: input.binding_key,
        version: input.version,
        jobDefinitionId: `${definitionRow.definition_json.jobKey}:${definitionRow.definition_json.version}`,
        activationState: input.activation_state,
        topology: input.topology,
        capabilityProfiles: profileResult.rows.map((row) => row.profile_json),
        offSwitchReference: input.off_switch_reference,
        shadowEvidence: assessmentResult.rows.map((row) => ({ assessmentId: row.id, verdict: "passed", independence: "independent" })),
        metadata: input.metadata ?? {},
      });
      const preflight = evaluateActivationPreflight(definitionRow.definition_json, binding);
      if (input.activation_state === "active" && !preflight.compatible) {
        throw new PersistenceError("job_registry_preflight_failed", "active deployment failed capability or autonomy preflight", { reasons: preflight.reasons, gaps: preflight.capabilityGaps });
      }
      const canonical = canonicalJson(binding as unknown as CoreJsonValue);
      const hash = sha256Hex(canonical);
      const result = await this.pool.query<BindingRow>(
        `insert into agent_feed.job_deployment_binding_versions (
           id, tenant_id, binding_key, version, job_definition_version_id, activation_state,
           scheduler_provider, executor_provider, ingress_kind, capability_profile_version_ids,
           off_switch_reference, shadow_assessment_ids, preflight_json, binding_json,
           binding_canonical_json, binding_hash, metadata
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11,$12::uuid[],$13::jsonb,$14::jsonb,$15,$16,$17::jsonb)
         returning id, tenant_id, binding_key, version, job_definition_version_id, activation_state,
           scheduler_provider, executor_provider, ingress_kind, capability_profile_version_ids,
           off_switch_reference, shadow_assessment_ids, preflight_json, binding_hash, metadata, created_at`,
        [randomUUID(), tenantId, input.binding_key, input.version, input.job_definition_version_id, input.activation_state,
          input.topology.schedulerProvider, input.topology.executorProvider, input.topology.ingressKind,
          input.capability_profile_version_ids, input.off_switch_reference, shadowIds, json(preflight), json(binding),
          canonical, hash, json(input.metadata ?? {})],
      );
      return mapBinding(result.rows[0]!);
    } catch (error) { return mapError(error); }
  }

  async getJobDefinitionVersion(tenantId: string, id: string): Promise<JobDefinitionVersion | null> {
    const result = await this.pool.query<DefinitionRow>("select id, tenant_id, definition_json, definition_hash, metadata, created_at from agent_feed.job_definition_versions where tenant_id = $1 and id = $2", [tenantId, id]);
    return result.rows[0] ? mapDefinition(result.rows[0]) : null;
  }

  async listJobDefinitionVersions(options: JobRegistryListOptions = {}): Promise<JobDefinitionVersion[]> {
    const tenantId = options.tenant_id ?? "default";
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PersistenceError("invalid_input", "limit must be between 1 and 500");
    const result = await this.pool.query<DefinitionRow>(
      `select id, tenant_id, definition_json, definition_hash, metadata, created_at
         from agent_feed.job_definition_versions where tenant_id = $1 and ($2::text is null or job_key = $2)
        order by job_key, version desc limit $3`, [tenantId, options.job_key ?? null, limit],
    );
    return result.rows.map(mapDefinition);
  }

  async listDeploymentBindingVersions(options: JobRegistryListOptions = {}): Promise<JobDeploymentBindingVersion[]> {
    const tenantId = options.tenant_id ?? "default";
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PersistenceError("invalid_input", "limit must be between 1 and 500");
    const result = await this.pool.query<BindingRow>(
      `select id, tenant_id, binding_key, version, job_definition_version_id, activation_state,
        scheduler_provider, executor_provider, ingress_kind, capability_profile_version_ids,
        off_switch_reference, shadow_assessment_ids, preflight_json, binding_hash, metadata, created_at
        from agent_feed.job_deployment_binding_versions where tenant_id = $1 and ($2::text is null or binding_key = $2)
        order by binding_key, version desc limit $3`, [tenantId, options.binding_key ?? null, limit],
    );
    return result.rows.map(mapBinding);
  }
}
