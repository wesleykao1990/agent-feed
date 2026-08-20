\set ON_ERROR_STOP on

-- Milestone 8 is an additive, append-only proof sidecar.  It does not change
-- protocol 0.1, producer ingress, or the technical run record.  The
-- registration and policy methods which write these tables are trusted
-- operator/composition-root methods; producer paths deliberately have no
-- access to them.
create extension if not exists pgcrypto;
create schema if not exists agent_feed;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'runs_tenant_id_id_key'
       and conrelid = 'agent_feed.runs'::regclass
  ) then
    alter table agent_feed.runs
      add constraint runs_tenant_id_id_key unique (tenant_id, id);
  end if;
end
$$;

create table if not exists agent_feed.validation_policy_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  policy_key text not null,
  version integer not null,
  policy_json jsonb not null,
  -- Exact canonical bytes emitted by assessment-core; PostgreSQL must not
  -- invent a second JSON canonicalization for the hash.
  policy_canonical_json text not null,
  policy_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, policy_key, version),
  check (length(tenant_id) between 1 and 256),
  check (length(policy_key) between 1 and 512),
  check (version >= 1),
  check (jsonb_typeof(policy_json) = 'object'),
  check (jsonb_typeof(metadata) = 'object'),
  check (policy_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists agent_feed.trusted_assessor_registration_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  assessor_id text not null,
  version integer not null,
  assessor_type text not null check (assessor_type in (
    'producer_self_check', 'independent_agent', 'human_reviewer',
    'validation_service'
  )),
  independence text not null check (independence in ('self', 'independent', 'unknown')),
  trusted_key_digest text,
  subject_digest text,
  status text not null default 'active' check (status in ('active', 'revoked', 'replaced')),
  supersedes_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, assessor_id, version),
  foreign key (tenant_id, supersedes_id)
    references agent_feed.trusted_assessor_registration_versions (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(assessor_id) between 1 and 512),
  check (version >= 1),
  check (trusted_key_digest is null or trusted_key_digest ~ '^[0-9a-f]{64}$'),
  check (subject_digest is null or subject_digest ~ '^[0-9a-f]{64}$'),
  check (trusted_key_digest is not null or subject_digest is not null),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists agent_feed.run_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  run_id uuid not null,
  policy_version_id uuid not null,
  assessor_registration_version_id uuid not null,
  -- These are immutable snapshots derived from the exact trusted registration
  -- row.  They are never accepted as submission input.
  assessor_id text not null,
  assessor_type text not null check (assessor_type in (
    'producer_self_check', 'independent_agent', 'human_reviewer',
    'validation_service'
  )),
  assessor_independence text not null check (assessor_independence in ('self', 'independent', 'unknown')),
  request_idempotency_key text not null,
  request_payload_hash text not null,
  assessment_kind text not null check (assessment_kind in (
    'technical', 'quality', 'security', 'compliance', 'operational'
  )),
  verdict text not null check (verdict in ('passed', 'failed', 'inconclusive', 'unknown')),
  failure_stage text not null default 'none' check (failure_stage in (
    'none', 'setup', 'execution', 'collection', 'validation', 'teardown', 'unknown'
  )),
  failure_class text not null default 'none' check (failure_class in (
    'none', 'configuration', 'authentication', 'authorization', 'dependency',
    'timeout', 'budget', 'rate_limit', 'provider', 'network', 'contract',
    'data_quality', 'security', 'cancelled', 'unknown'
  )),
  stop_reason text not null default 'completed' check (stop_reason in (
    'completed', 'policy_failed', 'budget_exhausted', 'timeout', 'cancelled',
    'assessor_error', 'dependency_unavailable', 'manual_stop', 'unknown'
  )),
  started_at timestamptz,
  completed_at timestamptz,
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  reassessment_of uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, request_idempotency_key),
  foreign key (tenant_id, run_id)
    references agent_feed.runs (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, policy_version_id)
    references agent_feed.validation_policy_versions (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, assessor_registration_version_id)
    references agent_feed.trusted_assessor_registration_versions (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, reassessment_of)
    references agent_feed.run_assessments (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(assessor_id) between 1 and 512),
  check (length(request_idempotency_key) between 8 and 512),
  check (request_payload_hash ~ '^[0-9a-f]{64}$'),
  check (length(summary) <= 16384),
  check (completed_at is null or started_at is null or completed_at >= started_at),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists agent_feed.assessment_declared_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  assessment_id uuid not null,
  budget_key text not null,
  state text not null check (state in ('declared', 'unknown', 'not_applicable')),
  limit_value numeric,
  unit text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, assessment_id, budget_key),
  foreign key (tenant_id, assessment_id)
    references agent_feed.run_assessments (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(budget_key) between 1 and 256),
  check (length(unit) <= 128),
  check (state = 'declared' and limit_value is not null and limit_value >= 0
         or state in ('unknown', 'not_applicable') and limit_value is null),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists agent_feed.assessment_usage_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  assessment_id uuid not null,
  usage_key text not null,
  metric text not null check (metric in (
    'wall_time_ms', 'input_tokens', 'output_tokens', 'cost_microunits',
    'tool_calls', 'network_requests', 'artifact_bytes'
  )),
  state text not null check (state in ('observed', 'unknown', 'not_applicable')),
  value numeric,
  unit text not null default '',
  provenance text not null check (provenance in (
    'provider_reported', 'executor_measured', 'assessor_observed',
    'operator_entered', 'derived', 'unknown'
  )),
  provenance_details jsonb not null default '{}'::jsonb,
  observed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, assessment_id, usage_key),
  foreign key (tenant_id, assessment_id)
    references agent_feed.run_assessments (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(usage_key) between 1 and 256),
  check (length(unit) <= 128),
  check (state = 'observed' and value is not null and value >= 0 and provenance <> 'unknown'
         or state in ('unknown', 'not_applicable') and value is null),
  check (jsonb_typeof(provenance_details) = 'object'),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists agent_feed.assessment_artifact_references (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  assessment_id uuid not null,
  artifact_key text not null,
  artifact_kind text not null,
  artifact_hash text not null,
  hash_algorithm text not null default 'sha256' check (hash_algorithm = 'sha256'),
  identity text,
  reference text,
  provenance jsonb not null default '{}'::jsonb,
  media_type text,
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, assessment_id, artifact_key),
  foreign key (tenant_id, assessment_id)
    references agent_feed.run_assessments (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(artifact_key) between 1 and 256),
  check (length(artifact_kind) between 1 and 256),
  check (artifact_hash ~ '^[0-9a-f]{64}$'),
  check (identity is null or (length(identity) <= 2048 and identity !~ '[?#]' and identity !~* '(base64|credential|password|secret|signed[[:space:]_-]*url)')),
  check (reference is null or length(reference) <= 2048),
  check (reference is null or (reference !~ '[?#]' and reference !~* '(base64|credential|password|secret|signed[[:space:]_-]*url)')),
  check (size_bytes is null or size_bytes >= 0),
  check (jsonb_typeof(provenance) in ('object', 'string', 'null')),
  check (provenance::text !~* '(blob|content|base64|credential|password|secret|signed[[:space:]_-]*url)'),
  check (metadata::text !~* '(blob|content|base64|credential|password|secret|signed[[:space:]_-]*url)'),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists run_assessments_run_idx
  on agent_feed.run_assessments (tenant_id, run_id, created_at desc);
create index if not exists run_assessments_policy_idx
  on agent_feed.run_assessments (tenant_id, policy_version_id, created_at desc);
create index if not exists assessment_usage_metric_idx
  on agent_feed.assessment_usage_observations (tenant_id, metric, created_at desc);

-- Every proof row is immutable. The trigger is intentionally generic so a
-- direct SQL caller cannot rewrite a receipt or any child telemetry/reference.
create or replace function agent_feed.protect_job_proof_row()
returns trigger language plpgsql as $$
begin
  raise exception 'Agent Feed job-proof rows are append-only';
end
$$;

drop trigger if exists validation_policy_versions_append_only on agent_feed.validation_policy_versions;
create trigger validation_policy_versions_append_only
before update or delete on agent_feed.validation_policy_versions
for each row execute function agent_feed.protect_job_proof_row();
drop trigger if exists trusted_assessor_registration_versions_append_only on agent_feed.trusted_assessor_registration_versions;
create trigger trusted_assessor_registration_versions_append_only
before update or delete on agent_feed.trusted_assessor_registration_versions
for each row execute function agent_feed.protect_job_proof_row();
drop trigger if exists run_assessments_append_only on agent_feed.run_assessments;
create trigger run_assessments_append_only
before update or delete on agent_feed.run_assessments
for each row execute function agent_feed.protect_job_proof_row();
drop trigger if exists assessment_declared_budgets_append_only on agent_feed.assessment_declared_budgets;
create trigger assessment_declared_budgets_append_only
before update or delete on agent_feed.assessment_declared_budgets
for each row execute function agent_feed.protect_job_proof_row();
drop trigger if exists assessment_usage_observations_append_only on agent_feed.assessment_usage_observations;
create trigger assessment_usage_observations_append_only
before update or delete on agent_feed.assessment_usage_observations
for each row execute function agent_feed.protect_job_proof_row();
drop trigger if exists assessment_artifact_references_append_only on agent_feed.assessment_artifact_references;
create trigger assessment_artifact_references_append_only
before update or delete on agent_feed.assessment_artifact_references
for each row execute function agent_feed.protect_job_proof_row();

-- PostgreSQL jsonb text is canonical for a stored jsonb value (object keys are
-- ordered); the repository also validates/hash-checks through assessment-core
-- before this trigger is reached. This duplicate check catches direct SQL
-- policy/hash drift without trusting a caller-provided hash.
create or replace function agent_feed.validate_job_proof_policy()
returns trigger language plpgsql as $$
declare
  required_kind text;
  required_independence text;
begin
  if new.policy_json->>'schemaVersion' <> 'agent-feed.validation-policy.v1' then
    raise exception 'validation policy schemaVersion must be agent-feed.validation-policy.v1';
  end if;
  if jsonb_typeof(new.policy_json->'requiredAssessmentKinds') <> 'array' then
    raise exception 'validation policy requiredAssessmentKinds must be an array';
  end if;
  for required_kind in select jsonb_array_elements_text(new.policy_json->'requiredAssessmentKinds') loop
    if required_kind not in ('technical', 'quality', 'security', 'compliance', 'operational') then
      raise exception 'validation policy contains an unknown assessment kind';
    end if;
  end loop;
  required_independence := new.policy_json->>'minimumIndependence';
  if required_independence not in ('self', 'independent') then
    raise exception 'validation policy minimumIndependence is invalid';
  end if;
  if new.policy_json->>'declaredBudgetRequirement' not in ('required', 'optional', 'not_applicable') then
    raise exception 'validation policy declaredBudgetRequirement is invalid';
  end if;
  if new.policy_json <> new.policy_canonical_json::jsonb then
    raise exception 'validation policy JSON does not match assessment-core canonical bytes';
  end if;
  if new.policy_hash <> encode(digest(new.policy_canonical_json, 'sha256'), 'hex') then
    raise exception 'validation policy hash does not match canonical policy';
  end if;
  return new;
end
$$;

drop trigger if exists validation_policy_versions_validate on agent_feed.validation_policy_versions;
create trigger validation_policy_versions_validate
before insert on agent_feed.validation_policy_versions
for each row execute function agent_feed.validate_job_proof_policy();

create or replace function agent_feed.validate_trusted_assessor_registration()
returns trigger language plpgsql as $$
begin
  if new.assessor_type = 'producer_self_check' and new.independence <> 'self' then
    raise exception 'producer_self_check registrations are always self';
  end if;
  if new.status = 'active' and exists (
    select 1 from agent_feed.trusted_assessor_registration_versions newer
     where newer.tenant_id = new.tenant_id
       and newer.supersedes_id = new.id
       and newer.status in ('active', 'replaced')
  ) then
    raise exception 'an assessor registration superseded by a newer version cannot be active';
  end if;
  if new.supersedes_id is not null and not exists (
    select 1 from agent_feed.trusted_assessor_registration_versions prior
     where prior.tenant_id = new.tenant_id
       and prior.id = new.supersedes_id
       and prior.assessor_id = new.assessor_id
       and prior.version < new.version
  ) then
    raise exception 'assessor replacement must supersede an earlier same-tenant version';
  end if;
  return new;
end
$$;

drop trigger if exists trusted_assessor_registration_versions_validate on agent_feed.trusted_assessor_registration_versions;
create trigger trusted_assessor_registration_versions_validate
before insert on agent_feed.trusted_assessor_registration_versions
for each row execute function agent_feed.validate_trusted_assessor_registration();

-- Compare every authority snapshot against the exact immutable registration
-- version. A caller can select a trusted version but cannot claim its identity,
-- type, or independence. The policy check also keeps quality proof separate
-- from technical run status: no run status is copied into this table.
create or replace function agent_feed.validate_run_assessment()
returns trigger language plpgsql as $$
declare
  run_tenant text;
  policy_tenant text;
  policy_json_value jsonb;
  registration_tenant text;
  registration_id text;
  registration_type text;
  registration_independence text;
  minimum_independence text;
  required_kinds jsonb;
  prior_run uuid;
  prior_policy uuid;
begin
  select tenant_id into run_tenant from agent_feed.runs where tenant_id = new.tenant_id and id = new.run_id;
  select tenant_id, policy_json into policy_tenant, policy_json_value
    from agent_feed.validation_policy_versions
   where tenant_id = new.tenant_id and id = new.policy_version_id;
  select tenant_id, assessor_id, assessor_type, independence
    into registration_tenant, registration_id, registration_type, registration_independence
    from agent_feed.trusted_assessor_registration_versions
   where tenant_id = new.tenant_id
     and id = new.assessor_registration_version_id
     and status = 'active';
  if run_tenant is null or policy_tenant is null or registration_tenant is null then
    raise exception 'assessment run, policy, and trusted assessor must share a tenant';
  end if;
  if exists (
    select 1 from agent_feed.trusted_assessor_registration_versions newer
     where newer.tenant_id = new.tenant_id
       and newer.supersedes_id = new.assessor_registration_version_id
       and newer.status in ('active', 'replaced')
  ) then
    raise exception 'assessment authority registration has been superseded';
  end if;
  if new.assessor_id <> registration_id
     or new.assessor_type <> registration_type
     or new.assessor_independence <> registration_independence then
    raise exception 'assessment authority snapshot does not match trusted registration version';
  end if;
  if registration_type = 'producer_self_check' and registration_independence <> 'self' then
    raise exception 'producer_self_check assessment cannot claim independence';
  end if;
  if registration_independence = 'unknown' then
    raise exception 'assessment authority independence is unknown';
  end if;
  required_kinds := policy_json_value->'requiredAssessmentKinds';
  if jsonb_array_length(required_kinds) > 0 and not (required_kinds @> jsonb_build_array(new.assessment_kind)) then
    raise exception 'assessment kind is not required by the validation policy';
  end if;
  minimum_independence := policy_json_value->>'minimumIndependence';
  if minimum_independence = 'independent' and registration_independence <> 'independent' then
    raise exception 'validation policy requires an independent assessor';
  end if;
  if minimum_independence = 'self' and registration_independence not in ('self', 'independent') then
    raise exception 'validation policy requires a self or independent assessor';
  end if;
  if new.reassessment_of is not null then
    select prior.run_id, prior.policy_version_id
      into prior_run, prior_policy
      from agent_feed.run_assessments prior
     where prior.tenant_id = new.tenant_id and prior.id = new.reassessment_of;
    if prior_run is null or prior_run <> new.run_id or prior_policy <> new.policy_version_id then
      raise exception 'reassessment_of must reference the same tenant, run, and policy version';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists run_assessments_validate on agent_feed.run_assessments;
create trigger run_assessments_validate
before insert on agent_feed.run_assessments
for each row execute function agent_feed.validate_run_assessment();

-- A policy may require a declared budget. This is deferred so a trusted
-- repository transaction can append the parent and immutable child rows in
-- one transaction while direct SQL still fails at commit.
create or replace function agent_feed.validate_assessment_budget_requirement()
returns trigger language plpgsql as $$
declare
  policy_budget text;
  budget_required boolean := false;
begin
  select vp.policy_json->>'declaredBudgetRequirement'
    into policy_budget
    from agent_feed.run_assessments ra
    join agent_feed.validation_policy_versions vp
      on vp.tenant_id = ra.tenant_id and vp.id = ra.policy_version_id
   where ra.tenant_id = new.tenant_id and ra.id = new.id;
  budget_required := policy_budget = 'required';
  if budget_required and not exists (
    select 1 from agent_feed.assessment_declared_budgets b
     where b.tenant_id = new.tenant_id
       and b.assessment_id = new.id
       and b.state = 'declared'
  ) then
    raise exception 'validation policy requires a declared budget';
  end if;
  if policy_budget = 'not_applicable' and exists (
    select 1 from agent_feed.assessment_declared_budgets b
     where b.tenant_id = new.tenant_id
       and b.assessment_id = new.id
       and b.state = 'declared'
  ) then
    raise exception 'validation policy does not allow a declared budget';
  end if;
  return new;
end
$$;

drop trigger if exists run_assessments_budget_requirement on agent_feed.run_assessments;
create constraint trigger run_assessments_budget_requirement
after insert on agent_feed.run_assessments
deferrable initially deferred
for each row execute function agent_feed.validate_assessment_budget_requirement();

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into agent_feed.schema_migrations (version)
values ('0005_job_proof')
on conflict (version) do nothing;
