\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create schema if not exists agent_feed;

create or replace function agent_feed.protect_utility_feedback_row()
returns trigger language plpgsql as $$
begin
  raise exception 'utility feedback records are append-only';
end
$$;

create or replace function agent_feed.m12_json_has_exact_keys(value jsonb, expected text[])
returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(value) = 'object'
    and (select array_agg(key order by key) from jsonb_object_keys(value) key)
      = (select array_agg(item order by item) from unnest(expected) item)
  , false)
$$;

create table if not exists agent_feed.utility_feedback_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null check (length(tenant_id) between 1 and 256),
  consumer_id text not null check (length(consumer_id) between 1 and 256),
  feedback_key text not null check (feedback_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  target_kind text not null check (target_kind in ('finding', 'artifact')),
  stream_id text not null check (length(stream_id) between 1 and 256),
  wire_run_id text not null check (length(wire_run_id) between 8 and 512),
  finding_id text,
  assessment_receipt_id text,
  artifact_digest text,
  job_key text not null check (job_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  definition_version integer not null check (definition_version >= 1),
  job_definition_hash text not null check (job_definition_hash ~ '^[a-f0-9]{64}$'),
  validation_policy_version_id text not null check (validation_policy_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  disposition text not null check (disposition in ('surfaced','ignored','duplicate','invalid','saved','acted_on','promoted','rejected')),
  reason_code text check (reason_code in ('relevant','not_relevant','already_known','unsupported_claim','insufficient_evidence','consumer_policy','user_saved','user_action','canonicalized','review_rejected')),
  occurred_at timestamptz not null,
  record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
  record_canonical_json text not null,
  record_hash text not null check (record_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, feedback_key),
  check (
    target_kind = 'finding' and finding_id is not null and assessment_receipt_id is null and artifact_digest is null
    or target_kind = 'artifact' and finding_id is null and assessment_receipt_id is not null and artifact_digest ~ '^[a-f0-9]{64}$'
  )
);

create table if not exists agent_feed.optimization_recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null check (length(tenant_id) between 1 and 256),
  consumer_id text not null check (length(consumer_id) between 1 and 256),
  recommendation_key text not null check (recommendation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  job_key text not null check (job_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  definition_version integer not null check (definition_version >= 1),
  job_definition_hash text not null check (job_definition_hash ~ '^[a-f0-9]{64}$'),
  validation_policy_version_id text not null check (validation_policy_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  recommendation_kind text not null check (recommendation_kind in ('prompt_change','schedule_change')),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  controlled_reference text not null check (
    controlled_reference ~ '^ref:[a-z0-9][a-z0-9._:/-]{2,255}$'
    and controlled_reference !~* '(^|[._:/-])(api[_-]?key|bearer|credential|password|secret|token)([._:/-]|$)'
  ),
  created_for_at timestamptz not null,
  recommendation_json jsonb not null check (jsonb_typeof(recommendation_json) = 'object'),
  recommendation_canonical_json text not null,
  recommendation_hash text not null check (recommendation_hash ~ '^[a-f0-9]{64}$'),
  persisted_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, recommendation_key),
  unique (tenant_id, consumer_id, recommendation_key, recommendation_hash)
);

create table if not exists agent_feed.recommendation_approval_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null check (length(tenant_id) between 1 and 256),
  consumer_id text not null check (length(consumer_id) between 1 and 256),
  approver_id text not null check (approver_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  approval_key text not null check (approval_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  recommendation_key text not null,
  recommendation_hash text not null check (recommendation_hash ~ '^[a-f0-9]{64}$'),
  decision text not null check (decision in ('approved','rejected')),
  decided_at timestamptz not null,
  approval_json jsonb not null check (jsonb_typeof(approval_json) = 'object'),
  approval_canonical_json text not null,
  approval_hash text not null check (approval_hash ~ '^[a-f0-9]{64}$'),
  persisted_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, approval_key),
  foreign key (tenant_id, consumer_id, recommendation_key, recommendation_hash)
    references agent_feed.optimization_recommendations (tenant_id, consumer_id, recommendation_key, recommendation_hash)
    on delete restrict
);

create or replace function agent_feed.validate_utility_feedback_event()
returns trigger language plpgsql as $$
begin
  if new.tenant_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or new.consumer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or new.stream_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or new.wire_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or (new.finding_id is not null and new.finding_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
     or (new.assessment_receipt_id is not null and new.assessment_receipt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
     or not agent_feed.m12_json_has_exact_keys(new.record_json, array['schemaVersion','feedbackKey','owner','target','scope','disposition','reasonCode','occurredAt','recordHash'])
     or not agent_feed.m12_json_has_exact_keys(new.record_json->'owner', array['tenantId','consumerId'])
     or not agent_feed.m12_json_has_exact_keys(new.record_json->'scope', array['jobKey','definitionVersion','jobDefinitionHash','validationPolicyVersionId'])
     or not (
       new.target_kind = 'finding' and agent_feed.m12_json_has_exact_keys(new.record_json->'target', array['targetKind','streamId','runId','findingId'])
       or new.target_kind = 'artifact' and agent_feed.m12_json_has_exact_keys(new.record_json->'target', array['targetKind','streamId','runId','assessmentReceiptId','artifactDigest'])
     )
     or jsonb_typeof(new.record_json#>'{scope,definitionVersion}') <> 'number'
     or jsonb_typeof(new.record_json->'reasonCode') not in ('string','null')
     or new.record_json->>'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or new.record_hash is distinct from encode(digest(convert_to(new.record_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.record_canonical_json::jsonb is distinct from new.record_json - 'recordHash'
     or new.record_json->>'recordHash' is distinct from new.record_hash
     or new.record_json->>'schemaVersion' is distinct from 'agent-feed.utility-feedback.v1'
     or new.record_json#>>'{owner,tenantId}' is distinct from new.tenant_id
     or new.record_json#>>'{owner,consumerId}' is distinct from new.consumer_id
     or new.record_json->>'feedbackKey' is distinct from new.feedback_key
     or new.record_json#>>'{target,targetKind}' is distinct from new.target_kind
     or new.record_json#>>'{target,streamId}' is distinct from new.stream_id
     or new.record_json#>>'{target,runId}' is distinct from new.wire_run_id
     or new.record_json#>>'{target,findingId}' is distinct from new.finding_id
     or new.record_json#>>'{target,assessmentReceiptId}' is distinct from new.assessment_receipt_id
     or new.record_json#>>'{target,artifactDigest}' is distinct from new.artifact_digest
     or new.record_json#>>'{scope,jobKey}' is distinct from new.job_key
     or (new.record_json#>>'{scope,definitionVersion}')::integer is distinct from new.definition_version
     or new.record_json#>>'{scope,jobDefinitionHash}' is distinct from new.job_definition_hash
     or new.record_json#>>'{scope,validationPolicyVersionId}' is distinct from new.validation_policy_version_id
     or new.record_json->>'disposition' is distinct from new.disposition
     or new.record_json->>'reasonCode' is distinct from new.reason_code
     or (new.record_json->>'occurredAt')::timestamptz is distinct from new.occurred_at then
    raise exception 'utility feedback canonical record or projection mismatch';
  end if;
  if new.target_kind = 'finding' and not exists (
    select 1 from agent_feed.runs run
    join agent_feed.findings finding on finding.run_id = run.id
    where run.tenant_id = new.tenant_id and run.wire_run_id = new.wire_run_id
      and run.stream_id = new.stream_id and finding.finding_key = new.finding_id
  ) then raise exception 'utility feedback finding target not found in tenant'; end if;
  if new.target_kind = 'artifact' and not exists (
    select 1 from agent_feed.runs run
    join agent_feed.run_assessments assessment on assessment.run_id = run.id and assessment.tenant_id = run.tenant_id
    join agent_feed.assessment_receipt_seals seal on seal.assessment_id = assessment.id and seal.tenant_id = assessment.tenant_id
    join agent_feed.assessment_artifact_references artifact on artifact.assessment_id = assessment.id and artifact.tenant_id = assessment.tenant_id
    where run.tenant_id = new.tenant_id and run.wire_run_id = new.wire_run_id
      and run.stream_id = new.stream_id and assessment.id::text = new.assessment_receipt_id
      and artifact.artifact_hash = new.artifact_digest
  ) then raise exception 'utility feedback artifact target not found or unsealed in tenant'; end if;
  return new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'utility feedback projection is invalid';
end
$$;

create or replace function agent_feed.validate_optimization_recommendation()
returns trigger language plpgsql as $$
begin
  if new.tenant_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or new.consumer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or not agent_feed.m12_json_has_exact_keys(new.recommendation_json, array['schemaVersion','recommendationKey','owner','scope','kind','proposalDigest','controlledReference','createdAt','approvalState','recommendationHash'])
     or not agent_feed.m12_json_has_exact_keys(new.recommendation_json->'owner', array['tenantId','consumerId'])
     or not agent_feed.m12_json_has_exact_keys(new.recommendation_json->'scope', array['jobKey','definitionVersion','jobDefinitionHash','validationPolicyVersionId'])
     or jsonb_typeof(new.recommendation_json#>'{scope,definitionVersion}') <> 'number'
     or new.recommendation_json->>'createdAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or new.recommendation_hash is distinct from encode(digest(convert_to(new.recommendation_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.recommendation_canonical_json::jsonb is distinct from new.recommendation_json - 'recommendationHash'
     or new.recommendation_json->>'recommendationHash' is distinct from new.recommendation_hash
     or new.recommendation_json->>'schemaVersion' is distinct from 'agent-feed.optimization-recommendation.v1'
     or new.recommendation_json#>>'{owner,tenantId}' is distinct from new.tenant_id
     or new.recommendation_json#>>'{owner,consumerId}' is distinct from new.consumer_id
     or new.recommendation_json->>'recommendationKey' is distinct from new.recommendation_key
     or new.recommendation_json#>>'{scope,jobKey}' is distinct from new.job_key
     or (new.recommendation_json#>>'{scope,definitionVersion}')::integer is distinct from new.definition_version
     or new.recommendation_json#>>'{scope,jobDefinitionHash}' is distinct from new.job_definition_hash
     or new.recommendation_json#>>'{scope,validationPolicyVersionId}' is distinct from new.validation_policy_version_id
     or new.recommendation_json->>'kind' is distinct from new.recommendation_kind
     or new.recommendation_json->>'proposalDigest' is distinct from new.proposal_digest
     or new.recommendation_json->>'controlledReference' is distinct from new.controlled_reference
     or new.recommendation_json->>'approvalState' is distinct from 'pending'
     or (new.recommendation_json->>'createdAt')::timestamptz is distinct from new.created_for_at then
    raise exception 'optimization recommendation canonical record or projection mismatch';
  end if;
  return new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'optimization recommendation projection is invalid';
end
$$;

create or replace function agent_feed.validate_recommendation_approval_event()
returns trigger language plpgsql as $$
begin
  if new.tenant_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or new.consumer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     or not agent_feed.m12_json_has_exact_keys(new.approval_json, array['schemaVersion','approvalKey','recommendationKey','recommendationHash','decision','decidedAt','tenantId','consumerId','approverId'])
     or new.approval_json->>'decidedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or new.approval_hash is distinct from encode(digest(convert_to(new.approval_canonical_json, 'utf8'), 'sha256'), 'hex')
     or new.approval_canonical_json::jsonb is distinct from new.approval_json
     or new.approval_json->>'schemaVersion' is distinct from 'agent-feed.recommendation-approval.v1'
     or new.approval_json->>'tenantId' is distinct from new.tenant_id
     or new.approval_json->>'consumerId' is distinct from new.consumer_id
     or new.approval_json->>'approverId' is distinct from new.approver_id
     or new.approval_json->>'approvalKey' is distinct from new.approval_key
     or new.approval_json->>'recommendationKey' is distinct from new.recommendation_key
     or new.approval_json->>'recommendationHash' is distinct from new.recommendation_hash
     or new.approval_json->>'decision' is distinct from new.decision
     or (new.approval_json->>'decidedAt')::timestamptz is distinct from new.decided_at then
    raise exception 'recommendation approval canonical record or projection mismatch';
  end if;
  return new;
exception when invalid_text_representation then
  raise exception 'recommendation approval projection is invalid';
end
$$;

drop trigger if exists utility_feedback_events_validate on agent_feed.utility_feedback_events;
create trigger utility_feedback_events_validate before insert on agent_feed.utility_feedback_events
for each row execute function agent_feed.validate_utility_feedback_event();
drop trigger if exists optimization_recommendations_validate on agent_feed.optimization_recommendations;
create trigger optimization_recommendations_validate before insert on agent_feed.optimization_recommendations
for each row execute function agent_feed.validate_optimization_recommendation();
drop trigger if exists recommendation_approval_events_validate on agent_feed.recommendation_approval_events;
create trigger recommendation_approval_events_validate before insert on agent_feed.recommendation_approval_events
for each row execute function agent_feed.validate_recommendation_approval_event();

drop trigger if exists utility_feedback_events_immutable on agent_feed.utility_feedback_events;
create trigger utility_feedback_events_immutable before update or delete on agent_feed.utility_feedback_events
for each row execute function agent_feed.protect_utility_feedback_row();
drop trigger if exists optimization_recommendations_immutable on agent_feed.optimization_recommendations;
create trigger optimization_recommendations_immutable before update or delete on agent_feed.optimization_recommendations
for each row execute function agent_feed.protect_utility_feedback_row();
drop trigger if exists recommendation_approval_events_immutable on agent_feed.recommendation_approval_events;
create trigger recommendation_approval_events_immutable before update or delete on agent_feed.recommendation_approval_events
for each row execute function agent_feed.protect_utility_feedback_row();

create index if not exists utility_feedback_scope_idx
  on agent_feed.utility_feedback_events (tenant_id, consumer_id, job_key, occurred_at desc);
create index if not exists optimization_recommendations_scope_idx
  on agent_feed.optimization_recommendations (tenant_id, consumer_id, job_key, created_for_at desc);
create index if not exists recommendation_approvals_recommendation_idx
  on agent_feed.recommendation_approval_events (tenant_id, consumer_id, recommendation_key, decided_at desc);

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into agent_feed.schema_migrations (version) values ('0007_utility_feedback') on conflict (version) do nothing;
