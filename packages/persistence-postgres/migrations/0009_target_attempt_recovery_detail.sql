\set ON_ERROR_STOP on

-- Add a precise, provider-neutral retrieval detail without changing the
-- existing coarse target-attempt outcome or protocol 0.1.
alter table agent_feed.target_attempts
  add column if not exists recovery_detail text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'agent_feed'
       and t.relname = 'target_attempts'
       and c.conname = 'target_attempts_recovery_detail_allowed'
  ) then
    alter table agent_feed.target_attempts
      add constraint target_attempts_recovery_detail_allowed
      check (recovery_detail is null or recovery_detail in (
        'http_failure', 'js_empty', 'marker_missing', 'partial_role',
        'safety_rejected', 'resolved'
      ));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'agent_feed'
       and t.relname = 'target_attempts'
       and c.conname = 'target_attempts_recovery_detail_coherent'
  ) then
    alter table agent_feed.target_attempts
      add constraint target_attempts_recovery_detail_coherent
      check (
        recovery_detail is null
        or (recovery_detail = 'resolved' and outcome = 'resolved')
        or (recovery_detail = 'http_failure' and outcome in ('not_found', 'access', 'auth', 'timeout'))
        or (recovery_detail = 'js_empty' and outcome in ('unsupported', 'validation_rejected'))
        or (recovery_detail in ('marker_missing', 'partial_role') and outcome = 'validation_rejected')
        or (recovery_detail = 'safety_rejected' and outcome in ('access', 'auth', 'validation_rejected'))
      );
  end if;
end
$$;

-- The new column is appended to each existing view so old view columns retain
-- their order and callers can observe the exact detail when present.
create or replace view agent_feed.target_attempt_latest as
select distinct on (tenant_id, job_deployment_id, run_id, work_unit_id, target_id)
  id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
  attempt_number, idempotency_key, payload_hash, input_digest, outcome,
  locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count,
  attempted_at, recorded_at, recovery_detail
from agent_feed.target_attempts
order by tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number desc, recorded_at desc, id desc;

create or replace view agent_feed.target_attempt_last_resolved as
select distinct on (tenant_id, job_deployment_id, run_id, work_unit_id, target_id)
  id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
  attempt_number, idempotency_key, payload_hash, input_digest, outcome,
  locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count,
  attempted_at, recorded_at, recovery_detail
from agent_feed.target_attempts
where outcome = 'resolved'
order by tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number desc, recorded_at desc, id desc;

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

insert into agent_feed.schema_migrations (version)
values ('0009_target_attempt_recovery_detail')
on conflict (version) do nothing;
