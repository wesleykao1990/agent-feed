\set ON_ERROR_STOP on

-- Generic resumable-work evidence.  These rows intentionally do not encode a
-- provider, source family, or economic/domain interpretation.
create extension if not exists pgcrypto;
create schema if not exists agent_feed;

-- A run may use one immutable deployment binding.  The association is kept as
-- a separate proof row so target attempts cannot silently switch deployment
-- halfway through a resumable run.
create table if not exists agent_feed.target_attempt_run_deployments (
  tenant_id text not null,
  run_id text not null,
  job_deployment_id uuid not null,
  bound_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  unique (tenant_id, run_id, job_deployment_id),
  foreign key (tenant_id, run_id)
    references agent_feed.runs (tenant_id, wire_run_id)
    on delete restrict,
  foreign key (tenant_id, job_deployment_id)
    references agent_feed.job_deployment_binding_versions (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(run_id) between 1 and 512 and run_id !~ '[[:space:][:cntrl:]]')
);

create table if not exists agent_feed.target_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  job_deployment_id uuid not null,
  run_id text not null,
  work_unit_id text not null,
  target_id text not null,
  attempt_number integer not null,
  idempotency_key text not null,
  payload_hash text not null,
  input_digest text not null,
  outcome text not null,
  locator_digest text,
  locator_reference text,
  accepted_finding_count integer not null default 0,
  accepted_evidence_count integer not null default 0,
  attempted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number),
  foreign key (tenant_id, run_id, job_deployment_id)
    references agent_feed.target_attempt_run_deployments (tenant_id, run_id, job_deployment_id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(run_id) between 1 and 512 and run_id !~ '[[:space:][:cntrl:]]'),
  check (length(work_unit_id) between 1 and 512 and work_unit_id !~ '[[:space:][:cntrl:]]'),
  check (length(target_id) between 1 and 512 and target_id !~ '[[:space:][:cntrl:]]'),
  check (attempt_number between 1 and 2147483647),
  check (length(idempotency_key) between 1 and 512 and idempotency_key !~ '[[:space:][:cntrl:]]'),
  check (payload_hash ~ '^[a-f0-9]{64}$'),
  check (input_digest ~ '^[a-f0-9]{64}$'),
  check (outcome in ('resolved','not_found','access','auth','timeout','unsupported','validation_rejected','interrupted')),
  check (locator_digest is null or locator_digest ~ '^[a-f0-9]{64}$'),
  check (locator_reference is null or (
    length(locator_reference) between 1 and 1024
    and locator_reference !~ '[[:space:][:cntrl:]]'
    and locator_reference !~ '[?#]'
    and locator_reference !~* '^data:'
    and locator_reference !~* '://[^/[:space:]]+@'
    and locator_reference !~* '(bearer|basic)[[:space:]:=]+[A-Za-z0-9._~+/=-]{8,}'
    and locator_reference !~* '(api[_-]?key|access[_-]?key|credential|password|secret|signature|token)[[:space:]:=/]+[^[:space:]/]+'
  )),
  check (accepted_finding_count between 0 and 2147483647),
  check (accepted_evidence_count between 0 and 2147483647),
  check (attempted_at >= '0001-01-01'::timestamptz)
);

create index if not exists target_attempts_target_idx
  on agent_feed.target_attempts (tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number desc);
create index if not exists target_attempts_run_idx
  on agent_feed.target_attempts (tenant_id, run_id, recorded_at desc);

create or replace function agent_feed.protect_target_attempt_row()
returns trigger language plpgsql as $$
begin
  raise exception 'target attempt ledger rows are append-only';
end
$$;

drop trigger if exists target_attempt_run_deployments_append_only on agent_feed.target_attempt_run_deployments;
create trigger target_attempt_run_deployments_append_only
before update or delete on agent_feed.target_attempt_run_deployments
for each row execute function agent_feed.protect_target_attempt_row();

drop trigger if exists target_attempts_append_only on agent_feed.target_attempts;
create trigger target_attempts_append_only
before update or delete on agent_feed.target_attempts
for each row execute function agent_feed.protect_target_attempt_row();

drop trigger if exists target_attempt_run_deployments_truncate on agent_feed.target_attempt_run_deployments;
create trigger target_attempt_run_deployments_truncate
before truncate on agent_feed.target_attempt_run_deployments
for each statement execute function agent_feed.protect_target_attempt_row();

drop trigger if exists target_attempts_truncate on agent_feed.target_attempts;
create trigger target_attempts_truncate
before truncate on agent_feed.target_attempts
for each statement execute function agent_feed.protect_target_attempt_row();

-- These are derived projections, not mutable state. A later failure therefore
-- cannot overwrite or erase the last successful resolution.
create or replace view agent_feed.target_attempt_latest as
select distinct on (tenant_id, job_deployment_id, run_id, work_unit_id, target_id)
  id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
  attempt_number, idempotency_key, payload_hash, input_digest, outcome,
  locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count,
  attempted_at, recorded_at
from agent_feed.target_attempts
order by tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number desc, recorded_at desc, id desc;

create or replace view agent_feed.target_attempt_last_resolved as
select distinct on (tenant_id, job_deployment_id, run_id, work_unit_id, target_id)
  id, tenant_id, job_deployment_id, run_id, work_unit_id, target_id,
  attempt_number, idempotency_key, payload_hash, input_digest, outcome,
  locator_digest, locator_reference, accepted_finding_count, accepted_evidence_count,
  attempted_at, recorded_at
from agent_feed.target_attempts
where outcome = 'resolved'
order by tenant_id, job_deployment_id, run_id, work_unit_id, target_id, attempt_number desc, recorded_at desc, id desc;

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

insert into agent_feed.schema_migrations (version)
values ('0008_target_attempt_ledger')
on conflict (version) do nothing;
