\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create schema if not exists agent_feed;

create or replace function agent_feed.protect_job_registry_row()
returns trigger language plpgsql as $$
begin
  raise exception 'job registry rows are append-only';
end
$$;

create or replace function agent_feed.registry_json_is_safe(value jsonb)
returns boolean language plpgsql immutable as $$
declare
  item record;
  normalized_key text;
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) = 'string' then
    return length(value #>> '{}') <= 4096
      and value #>> '{}' !~ '[[:cntrl:]]'
      and value #>> '{}' !~* '(^data:|[?&](token|signature|x-amz-signature)=|\m(bearer|basic)\M[[:space:]]+[A-Za-z0-9._~+/=-]{8,}|\m(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}|\msk-(proj-)?[A-Za-z0-9_-]{16,}|\mAKIA[0-9A-Z]{16}\M)';
  elsif jsonb_typeof(value) = 'number' then
    return (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
      and (value #>> '{}')::numeric between -9007199254740991 and 9007199254740991;
  elsif jsonb_typeof(value) = 'array' then
    if jsonb_array_length(value) > 64 then return false; end if;
    for item in select jsonb_array_elements(value) child loop
      if not agent_feed.registry_json_is_safe(item.child) then return false; end if;
    end loop;
  elsif jsonb_typeof(value) = 'object' then
    if (select count(*) from jsonb_object_keys(value)) > 64 then return false; end if;
    for item in select key, val from jsonb_each(value) as child(key, val) loop
      normalized_key := regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g');
      if normalized_key ~ '(authorization|credential|password|secret|token|privatekey|apikey|accesskey|signedurl|signature|inline|blob|base64|payload|content|body)'
         or not agent_feed.registry_json_is_safe(item.val) then return false; end if;
    end loop;
  end if;
  return true;
end
$$;

create or replace function agent_feed.registry_reference_is_safe(value text)
returns boolean language sql immutable as $$
  select value is null or (
    length(value) between 1 and 1024
    and value ~ '^(config|vault-ref|git\+https|object)://[A-Za-z0-9._~:/@+\-]+$'
    and value !~ '[?#]'
    and value !~* '(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/=-]{8,}'
  )
$$;

create or replace function agent_feed.m9_version_at_least(offered text, required text)
returns boolean language plpgsql immutable as $$
declare
  offered_parts text[];
  required_parts text[];
  index integer;
  left_value integer;
  right_value integer;
begin
  if offered !~ '^\d+(\.\d+){0,3}$' or required !~ '^\d+(\.\d+){0,3}$' then return false; end if;
  offered_parts := string_to_array(offered, '.');
  required_parts := string_to_array(required, '.');
  for index in 1..4 loop
    left_value := coalesce(offered_parts[index]::integer, 0);
    right_value := coalesce(required_parts[index]::integer, 0);
    if left_value > right_value then return true; end if;
    if left_value < right_value then return false; end if;
  end loop;
  return true;
exception when numeric_value_out_of_range then return false;
end
$$;

create table if not exists agent_feed.job_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  job_key text not null check (length(job_key) between 1 and 256),
  version integer not null check (version >= 1),
  owner_id text not null check (length(owner_id) between 1 and 256),
  lifecycle_state text not null check (lifecycle_state in ('draft','shadow','active','paused','retired')),
  instruction_digest text not null check (instruction_digest ~ '^[a-f0-9]{64}$'),
  instruction_reference text check (agent_feed.registry_reference_is_safe(instruction_reference)),
  validation_policy_version_id uuid,
  required_capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(required_capabilities) = 'array' and jsonb_array_length(required_capabilities) <= 64 and agent_feed.registry_json_is_safe(required_capabilities)),
  output_contracts jsonb not null default '[]'::jsonb check (jsonb_typeof(output_contracts) = 'array' and jsonb_array_length(output_contracts) <= 64 and agent_feed.registry_json_is_safe(output_contracts)),
  budgets jsonb not null default '[]'::jsonb check (jsonb_typeof(budgets) = 'array' and jsonb_array_length(budgets) <= 64 and agent_feed.registry_json_is_safe(budgets)),
  definition_json jsonb not null check (agent_feed.registry_json_is_safe(definition_json)),
  definition_canonical_json text not null,
  definition_hash text not null check (definition_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and agent_feed.registry_json_is_safe(metadata)),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, job_key, version),
  foreign key (tenant_id, validation_policy_version_id) references agent_feed.validation_policy_versions (tenant_id, id) on delete restrict,
  check (validation_policy_version_id is not null or lifecycle_state in ('draft','retired'))
);

create table if not exists agent_feed.capability_profile_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  profile_key text not null check (length(profile_key) between 1 and 256),
  version integer not null check (version >= 1),
  provider_key text not null check (length(provider_key) between 1 and 256),
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array' and jsonb_array_length(capabilities) <= 128 and agent_feed.registry_json_is_safe(capabilities)),
  profile_json jsonb not null check (agent_feed.registry_json_is_safe(profile_json)),
  profile_canonical_json text not null,
  profile_hash text not null check (profile_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and agent_feed.registry_json_is_safe(metadata)),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, profile_key, version)
);

create table if not exists agent_feed.job_deployment_binding_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  binding_key text not null check (length(binding_key) between 1 and 256),
  version integer not null check (version >= 1),
  job_definition_version_id uuid not null,
  activation_state text not null check (activation_state in ('shadow','active','disabled')),
  scheduler_provider text not null check (length(scheduler_provider) between 1 and 256),
  executor_provider text not null check (length(executor_provider) between 1 and 256),
  ingress_kind text not null check (ingress_kind in ('rest','mcp','webhook','local_file','manual_export')),
  capability_profile_version_ids uuid[] not null check (cardinality(capability_profile_version_ids) <= 32),
  off_switch_reference text check (agent_feed.registry_reference_is_safe(off_switch_reference)),
  shadow_assessment_ids uuid[] not null default '{}'::uuid[] check (cardinality(shadow_assessment_ids) <= 32),
  preflight_json jsonb not null check (jsonb_typeof(preflight_json) = 'object' and agent_feed.registry_json_is_safe(preflight_json)),
  binding_json jsonb not null check (jsonb_typeof(binding_json) = 'object' and agent_feed.registry_json_is_safe(binding_json)),
  binding_canonical_json text not null,
  binding_hash text not null check (binding_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and agent_feed.registry_json_is_safe(metadata)),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, binding_key, version),
  foreign key (tenant_id, job_definition_version_id) references agent_feed.job_definition_versions (tenant_id, id) on delete restrict
);

create or replace function agent_feed.validate_job_definition_version()
returns trigger language plpgsql as $$
begin
  if new.definition_hash <> encode(digest(convert_to(new.definition_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.definition_canonical_json::jsonb <> new.definition_json then
    raise exception 'job definition canonical hash mismatch';
  end if;
  if new.definition_json->>'jobKey' <> new.job_key
     or (new.definition_json->>'version')::integer <> new.version
     or new.definition_json->>'ownerId' <> new.owner_id
     or new.definition_json->>'lifecycleState' <> new.lifecycle_state
     or new.definition_json#>>'{instructions,digest}' <> new.instruction_digest
     or new.definition_json#>>'{instructions,controlledReference}' is distinct from new.instruction_reference
     or new.definition_json->>'validationPolicyVersionId' is distinct from new.validation_policy_version_id::text
     or new.definition_json->'requiredCapabilities' <> new.required_capabilities
     or new.definition_json->'outputContracts' <> new.output_contracts
     or new.definition_json->'budgets' <> new.budgets then
    raise exception 'job definition projection mismatch';
  end if;
  if new.definition_json->>'schemaVersion' <> 'agent-feed.job-definition.v1'
     or jsonb_typeof(new.definition_json->'instructions') <> 'object'
     or exists (
       select 1 from jsonb_array_elements(new.required_capabilities) requirement
        where jsonb_typeof(requirement) <> 'object'
          or coalesce(length(requirement->>'key'), 0) not between 1 and 256
          or requirement->>'role' not in ('scheduler','executor','ingress')
          or (requirement->>'minimumVersion' is not null and requirement->>'minimumVersion' !~ '^\d+(\.\d+){0,3}$')
     )
     or exists (
       select 1 from jsonb_array_elements(new.output_contracts) contract
        where jsonb_typeof(contract) <> 'object'
          or coalesce(length(contract->>'contractKey'), 0) not between 1 and 256
          or coalesce(length(contract->>'version'), 0) not between 1 and 256
          or contract->>'sha256' !~ '^[a-f0-9]{64}$'
     )
     or exists (
       select 1 from jsonb_array_elements(new.budgets) budget
        where jsonb_typeof(budget) <> 'object'
          or coalesce(length(budget->>'budgetKey'), 0) not between 1 and 256
          or coalesce(length(budget->>'unit'), 0) not between 1 and 256
          or jsonb_typeof(budget->'limit') <> 'number'
          or (budget->>'limit')::numeric <> trunc((budget->>'limit')::numeric)
          or (budget->>'limit')::numeric not between 0 and 9007199254740991
     )
     or exists (
       select 1 from jsonb_array_elements(new.required_capabilities) requirement
        group by requirement->>'role', requirement->>'key' having count(*) > 1
     )
     or exists (
       select 1 from jsonb_array_elements(new.output_contracts) contract
        group by contract->>'contractKey' having count(*) > 1
     )
     or exists (
       select 1 from jsonb_array_elements(new.budgets) budget
        group by budget->>'budgetKey' having count(*) > 1
     ) then raise exception 'job definition contract structure is invalid';
  end if;
  return new;
end
$$;

create or replace function agent_feed.validate_capability_profile_version()
returns trigger language plpgsql as $$
begin
  if new.profile_hash <> encode(digest(convert_to(new.profile_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.profile_canonical_json::jsonb <> new.profile_json then
    raise exception 'capability profile canonical hash mismatch';
  end if;
  if new.profile_json->>'profileKey' <> new.profile_key
     or (new.profile_json->>'version')::integer <> new.version
     or new.profile_json->>'providerKey' <> new.provider_key
     or new.profile_json->'capabilities' <> new.capabilities then
    raise exception 'capability profile projection mismatch';
  end if;
  if new.profile_json->>'schemaVersion' <> 'agent-feed.capability-profile.v1'
     or exists (
       select 1 from jsonb_array_elements(new.capabilities) capability
        where jsonb_typeof(capability) <> 'object'
          or coalesce(length(capability->>'key'), 0) not between 1 and 256
          or capability->>'role' not in ('scheduler','executor','ingress')
          or capability->>'version' !~ '^\d+(\.\d+){0,3}$'
          or jsonb_typeof(capability->'available') <> 'boolean'
     )
     or exists (
       select 1 from jsonb_array_elements(new.capabilities) capability
        group by capability->>'role', capability->>'key' having count(*) > 1
     ) then raise exception 'capability profile contract structure is invalid';
  end if;
  return new;
end
$$;

create or replace function agent_feed.validate_job_deployment_binding()
returns trigger language plpgsql as $$
declare
  definition agent_feed.job_definition_versions%rowtype;
  profile_count integer;
  assessment_count integer;
  requirement jsonb;
begin
  if new.binding_json->>'schemaVersion' <> 'agent-feed.deployment-binding.v1' then
    raise exception 'deployment binding schema version is invalid';
  end if;
  if new.binding_hash <> encode(digest(convert_to(new.binding_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.binding_canonical_json::jsonb <> new.binding_json then
    raise exception 'deployment binding canonical hash mismatch';
  end if;
  if new.binding_json->>'bindingKey' <> new.binding_key
     or (new.binding_json->>'version')::integer <> new.version
     or new.binding_json->>'activationState' <> new.activation_state
     or new.binding_json#>>'{topology,schedulerProvider}' <> new.scheduler_provider
     or new.binding_json#>>'{topology,executorProvider}' <> new.executor_provider
     or new.binding_json#>>'{topology,ingressKind}' <> new.ingress_kind then
    raise exception 'deployment binding projection mismatch';
  end if;
  if cardinality(new.capability_profile_version_ids) <> cardinality(array(select distinct unnest(new.capability_profile_version_ids)))
     or cardinality(new.shadow_assessment_ids) <> cardinality(array(select distinct unnest(new.shadow_assessment_ids))) then
    raise exception 'deployment binding references must be unique';
  end if;
  select * into definition from agent_feed.job_definition_versions
   where tenant_id = new.tenant_id and id = new.job_definition_version_id;
  if not found then raise exception 'job definition version not found in tenant'; end if;
  if new.binding_json->>'jobDefinitionId' <> definition.job_key || ':' || definition.version::text
     or new.binding_json->>'offSwitchReference' is distinct from new.off_switch_reference
     or jsonb_array_length(new.binding_json->'capabilityProfiles') <> cardinality(new.capability_profile_version_ids)
     or jsonb_array_length(new.binding_json->'shadowEvidence') <> cardinality(new.shadow_assessment_ids) then
    raise exception 'deployment binding reference projection mismatch';
  end if;
  select count(*) into profile_count from agent_feed.capability_profile_versions
   where tenant_id = new.tenant_id and id = any(new.capability_profile_version_ids);
  if profile_count <> cardinality(new.capability_profile_version_ids) then
    raise exception 'capability profile version not found in tenant';
  end if;
  if exists (
    select 1 from agent_feed.capability_profile_versions p
     where p.tenant_id = new.tenant_id and p.id = any(new.capability_profile_version_ids)
       and not (new.binding_json->'capabilityProfiles' @> jsonb_build_array(p.profile_json))
  ) then raise exception 'deployment binding embedded capability profile mismatch'; end if;
  if exists (
    select 1 from unnest(new.shadow_assessment_ids) assessment_id
     where not (new.binding_json->'shadowEvidence' @> jsonb_build_array(jsonb_build_object('assessmentId', assessment_id::text)))
  ) then raise exception 'deployment binding embedded shadow evidence mismatch'; end if;
  if new.preflight_json->>'jobDefinitionHash' <> definition.definition_hash
     or jsonb_array_length(new.preflight_json->'capabilityProfileHashes') <> cardinality(new.capability_profile_version_ids)
     or exists (
       select 1 from agent_feed.capability_profile_versions p
        where p.tenant_id = new.tenant_id and p.id = any(new.capability_profile_version_ids)
          and not (new.preflight_json->'capabilityProfileHashes' @> jsonb_build_array(p.profile_hash))
     ) then raise exception 'deployment preflight pin mismatch'; end if;
  if cardinality(new.capability_profile_version_ids) > 0 and not exists (
    select 1 from agent_feed.capability_profile_versions p
     where p.tenant_id = new.tenant_id and p.id = any(new.capability_profile_version_ids) and p.provider_key = new.scheduler_provider
  ) then raise exception 'scheduler provider has no pinned capability profile'; end if;
  if cardinality(new.capability_profile_version_ids) > 0 and not exists (
    select 1 from agent_feed.capability_profile_versions p
     where p.tenant_id = new.tenant_id and p.id = any(new.capability_profile_version_ids) and p.provider_key = new.executor_provider
  ) then raise exception 'executor provider has no pinned capability profile'; end if;
  for requirement in select value from jsonb_array_elements(definition.required_capabilities) loop
    if not exists (
      select 1 from agent_feed.capability_profile_versions p
      cross join lateral jsonb_array_elements(p.capabilities) offered
       where p.tenant_id = new.tenant_id and p.id = any(new.capability_profile_version_ids)
         and offered->>'key' = requirement->>'key'
         and offered->>'role' = requirement->>'role'
         and offered->>'available' = 'true'
         and (requirement->>'minimumVersion' is null or agent_feed.m9_version_at_least(offered->>'version', requirement->>'minimumVersion'))
    ) then raise exception 'deployment capability preflight failed for %', requirement->>'key'; end if;
  end loop;
  if new.activation_state = 'active' then
    if new.preflight_json->>'compatible' <> 'true'
       or new.preflight_json->'reasons' <> '["compatible"]'::jsonb then
      raise exception 'active deployment requires a successful pinned preflight';
    end if;
    if definition.lifecycle_state <> 'active' then raise exception 'active deployment requires active job definition'; end if;
    if definition.validation_policy_version_id is null then raise exception 'active deployment requires validation policy'; end if;
    if jsonb_array_length(definition.budgets) = 0 then raise exception 'active deployment requires declared budget'; end if;
    if new.off_switch_reference is null then raise exception 'active deployment requires off-switch reference'; end if;
    if cardinality(new.shadow_assessment_ids) = 0 then raise exception 'active deployment requires successful shadow evidence'; end if;
    select count(*) into assessment_count
      from agent_feed.run_assessments a
      join agent_feed.assessment_receipt_seals seal on seal.tenant_id = a.tenant_id and seal.assessment_id = a.id
     where a.tenant_id = new.tenant_id and a.id = any(new.shadow_assessment_ids)
       and a.verdict = 'passed' and a.assessor_independence = 'independent';
    if assessment_count <> cardinality(new.shadow_assessment_ids) then
      raise exception 'active deployment shadow evidence must be sealed, passed, and independent';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists job_definition_versions_validate on agent_feed.job_definition_versions;
create trigger job_definition_versions_validate before insert on agent_feed.job_definition_versions
for each row execute function agent_feed.validate_job_definition_version();
drop trigger if exists capability_profile_versions_validate on agent_feed.capability_profile_versions;
create trigger capability_profile_versions_validate before insert on agent_feed.capability_profile_versions
for each row execute function agent_feed.validate_capability_profile_version();
drop trigger if exists job_deployment_binding_versions_validate on agent_feed.job_deployment_binding_versions;
create trigger job_deployment_binding_versions_validate before insert on agent_feed.job_deployment_binding_versions
for each row execute function agent_feed.validate_job_deployment_binding();

drop trigger if exists job_definition_versions_immutable on agent_feed.job_definition_versions;
create trigger job_definition_versions_immutable before update or delete on agent_feed.job_definition_versions
for each row execute function agent_feed.protect_job_registry_row();
drop trigger if exists capability_profile_versions_immutable on agent_feed.capability_profile_versions;
create trigger capability_profile_versions_immutable before update or delete on agent_feed.capability_profile_versions
for each row execute function agent_feed.protect_job_registry_row();
drop trigger if exists job_deployment_binding_versions_immutable on agent_feed.job_deployment_binding_versions;
create trigger job_deployment_binding_versions_immutable before update or delete on agent_feed.job_deployment_binding_versions
for each row execute function agent_feed.protect_job_registry_row();

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into agent_feed.schema_migrations (version) values ('0006_job_registry') on conflict (version) do nothing;
