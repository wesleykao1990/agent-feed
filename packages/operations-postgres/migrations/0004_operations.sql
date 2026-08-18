\set ON_ERROR_STOP on

-- Milestone 5 operations tables are deliberately separate from the immutable
-- protocol and delivery ledgers.  Managed artifacts contain external storage
-- references only; retention never deletes runs, findings, evidence, outbox
-- events, delivery attempts, acknowledgements, or liveness incidents.
create extension if not exists pgcrypto;
create schema if not exists agent_feed;

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists agent_feed.retention_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  policy_key text not null,
  artifact_class text not null check (artifact_class in ('recovery', 'submitted_artifact', 'export', 'other')),
  action text not null check (action in ('delete', 'tombstone')),
  retention_seconds integer not null check (retention_seconds >= 1),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, policy_key),
  check (length(tenant_id) between 1 and 256),
  check (length(policy_key) between 1 and 256)
);

-- This registry is intentionally independent of Agent Feed protocol rows.  A
-- row may point to an object-store key or recovery bundle, but it never owns
-- the external object and has no foreign key to an immutable protocol ledger.
create table if not exists agent_feed.managed_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  artifact_key text not null,
  storage_ref text not null,
  artifact_class text not null check (artifact_class in ('recovery', 'submitted_artifact', 'export', 'other')),
  status text not null default 'active' check (status in ('active', 'retained', 'deleted', 'tombstoned')),
  legal_hold boolean not null default false,
  created_at timestamptz not null,
  expires_at timestamptz,
  content_hash text,
  source_run_id text,
  source_event_id text,
  metadata jsonb not null default '{}'::jsonb,
  registered_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstoned_at timestamptz,
  unique (tenant_id, artifact_key),
  unique (tenant_id, id),
  check (length(tenant_id) between 1 and 256),
  check (length(artifact_key) between 1 and 512),
  check (length(storage_ref) between 1 and 2048),
  check (storage_ref !~ '[?#@[:space:][:cntrl:]]'),
  check (content_hash is null or content_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (pg_column_size(metadata) <= 65536),
  check (
    (status in ('active', 'retained') and deleted_at is null and tombstoned_at is null)
    or (status = 'deleted' and deleted_at is not null and tombstoned_at is null)
    or (status = 'tombstoned' and deleted_at is null and tombstoned_at is not null)
  )
);

create table if not exists agent_feed.retention_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  idempotency_key text not null,
  policy_key text not null,
  action text not null check (action in ('delete', 'tombstone')),
  as_of timestamptz not null,
  requested_by text not null,
  request_hash text not null,
  max_items integer not null check (max_items between 1 and 1000),
  status text not null default 'planned' check (status in ('planned', 'executing', 'completed', 'failed')),
  candidate_count integer not null default 0 check (candidate_count between 0 and 1000),
  completed_count integer not null default 0 check (completed_count between 0 and 1000),
  failed_count integer not null default 0 check (failed_count between 0 and 1000),
  confirmation_token_hash text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, id),
  check (length(tenant_id) between 1 and 256),
  check (length(idempotency_key) between 8 and 256),
  check (length(requested_by) between 1 and 256),
  check (request_hash ~ '^[0-9a-f]{64}$'),
  check (confirmation_token_hash is null or confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  check (completed_count + failed_count <= candidate_count),
  check (completed_at is null or started_at is not null)
);

-- Items are a bounded immutable plan snapshot plus a small execution state.
-- The external adapter is responsible for idempotent deletion/tombstoning if a
-- process crashes after the external side effect and before this row commits.
create table if not exists agent_feed.retention_job_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  job_id uuid not null references agent_feed.retention_jobs(id) on delete restrict,
  artifact_id uuid not null references agent_feed.managed_artifacts(id) on delete restrict,
  artifact_key text not null,
  storage_ref text not null,
  artifact_class text not null check (artifact_class in ('recovery', 'submitted_artifact', 'export', 'other')),
  action text not null check (action in ('delete', 'tombstone')),
  expires_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'deleted', 'tombstoned', 'skipped', 'failed')),
  result_code text,
  claim_token uuid,
  claim_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id, artifact_id),
  unique (tenant_id, id),
  check (length(artifact_key) between 1 and 512),
  check (length(storage_ref) between 1 and 2048),
  check (result_code is null or result_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  check ((status = 'in_progress' and claim_token is not null and claim_expires_at is not null) or status <> 'in_progress')
);

-- This is the operations audit ledger.  It is append-only and stores bounded
-- metadata, never confirmation tokens or external payloads.
create table if not exists agent_feed.operations_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  job_id uuid references agent_feed.retention_jobs(id) on delete restrict,
  artifact_id uuid references agent_feed.managed_artifacts(id) on delete restrict,
  event_type text not null check (event_type in (
    'policy.upserted', 'artifact.registered', 'retention.plan_created',
    'retention.confirmed', 'retention.item_succeeded', 'retention.item_failed',
    'retention.item_skipped', 'retention.completed', 'retention.failed'
  )),
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (length(tenant_id) between 1 and 256),
  check (length(actor) between 1 and 256),
  check (pg_column_size(details) <= 16384)
);

alter table agent_feed.retention_job_items
  add column if not exists claim_token uuid;
alter table agent_feed.retention_job_items
  add column if not exists claim_expires_at timestamptz;

create index if not exists managed_artifacts_retention_idx
  on agent_feed.managed_artifacts (tenant_id, artifact_class, status, expires_at, created_at, id);
create index if not exists retention_jobs_scope_idx
  on agent_feed.retention_jobs (tenant_id, status, created_at, id);
create index if not exists retention_job_items_pending_idx
  on agent_feed.retention_job_items (tenant_id, job_id, status, id);
create index if not exists operations_audit_scope_idx
  on agent_feed.operations_audit (tenant_id, occurred_at, id);

alter table agent_feed.managed_artifacts
  add column if not exists legal_hold boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'managed_artifacts_storage_ref_opaque_ck'
       and conrelid = 'agent_feed.managed_artifacts'::regclass
  ) then
    alter table agent_feed.managed_artifacts
      add constraint managed_artifacts_storage_ref_opaque_ck
      check (storage_ref !~ '[?#@[:space:][:cntrl:]]') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'managed_artifacts_tenant_id_key'
       and conrelid = 'agent_feed.managed_artifacts'::regclass
  ) then
    alter table agent_feed.managed_artifacts
      add constraint managed_artifacts_tenant_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'retention_jobs_tenant_id_key'
       and conrelid = 'agent_feed.retention_jobs'::regclass
  ) then
    alter table agent_feed.retention_jobs
      add constraint retention_jobs_tenant_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'retention_job_items_tenant_id_key'
       and conrelid = 'agent_feed.retention_job_items'::regclass
  ) then
    alter table agent_feed.retention_job_items
      add constraint retention_job_items_tenant_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'operations_audit_tenant_id_key'
       and conrelid = 'agent_feed.operations_audit'::regclass
  ) then
    alter table agent_feed.operations_audit
      add constraint operations_audit_tenant_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'retention_job_items_tenant_job_fk'
       and conrelid = 'agent_feed.retention_job_items'::regclass
  ) then
    alter table agent_feed.retention_job_items
      add constraint retention_job_items_tenant_job_fk
      foreign key (tenant_id, job_id)
      references agent_feed.retention_jobs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'retention_job_items_tenant_artifact_fk'
       and conrelid = 'agent_feed.retention_job_items'::regclass
  ) then
    alter table agent_feed.retention_job_items
      add constraint retention_job_items_tenant_artifact_fk
      foreign key (tenant_id, artifact_id)
      references agent_feed.managed_artifacts (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'operations_audit_tenant_job_fk'
       and conrelid = 'agent_feed.operations_audit'::regclass
  ) then
    alter table agent_feed.operations_audit
      add constraint operations_audit_tenant_job_fk
      foreign key (tenant_id, job_id)
      references agent_feed.retention_jobs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'operations_audit_tenant_artifact_fk'
       and conrelid = 'agent_feed.operations_audit'::regclass
  ) then
    alter table agent_feed.operations_audit
      add constraint operations_audit_tenant_artifact_fk
      foreign key (tenant_id, artifact_id)
      references agent_feed.managed_artifacts (tenant_id, id)
      not valid;
  end if;
end
$$;

-- Upgrade paths may add these constraints as NOT VALID so existing rows can be
-- checked deliberately. A successful migration never leaves tenant boundaries
-- or the opaque-reference rule unvalidated.
alter table agent_feed.managed_artifacts
  validate constraint managed_artifacts_storage_ref_opaque_ck;
alter table agent_feed.retention_job_items
  validate constraint retention_job_items_tenant_job_fk;
alter table agent_feed.retention_job_items
  validate constraint retention_job_items_tenant_artifact_fk;
alter table agent_feed.operations_audit
  validate constraint operations_audit_tenant_job_fk;
alter table agent_feed.operations_audit
  validate constraint operations_audit_tenant_artifact_fk;

create or replace function agent_feed.protect_managed_artifact()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'managed artifact registry rows are append-only';
  end if;
  if new.tenant_id <> old.tenant_id
     or new.artifact_key <> old.artifact_key
     or new.storage_ref <> old.storage_ref
     or new.artifact_class <> old.artifact_class
     or new.created_at <> old.created_at
     or new.registered_at <> old.registered_at then
    raise exception 'managed artifact identity fields are immutable';
  end if;
  if old.status in ('deleted', 'tombstoned') and new.status <> old.status then
    raise exception 'managed artifact terminal status is immutable';
  end if;
  if new.legal_hold <> old.legal_hold and exists (
    select 1 from agent_feed.retention_job_items
     where tenant_id = old.tenant_id
       and artifact_id = old.id
       and status = 'in_progress'
  ) then
    raise exception 'cannot change legal hold while retention deletion is in progress';
  end if;
  if new.status = 'deleted' and (new.deleted_at is null or new.tombstoned_at is not null) then
    raise exception 'deleted artifact requires deleted_at only';
  end if;
  if new.status = 'tombstoned' and (new.tombstoned_at is null or new.deleted_at is not null) then
    raise exception 'tombstoned artifact requires tombstoned_at only';
  end if;
  return new;
end
$$;

drop trigger if exists managed_artifacts_append_only on agent_feed.managed_artifacts;
create trigger managed_artifacts_append_only
before update or delete on agent_feed.managed_artifacts
for each row execute function agent_feed.protect_managed_artifact();

create or replace function agent_feed.protect_retention_job()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'retention jobs are append-only state records';
  end if;
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.idempotency_key <> old.idempotency_key
     or new.policy_key <> old.policy_key
     or new.action <> old.action
     or new.as_of <> old.as_of
     or new.requested_by <> old.requested_by
     or new.request_hash <> old.request_hash
     or new.max_items <> old.max_items
     or new.created_at <> old.created_at then
    raise exception 'retention job identity is immutable';
  end if;
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'completed retention job is terminal';
  end if;
  if old.status = 'executing' and new.status = 'planned' then
    raise exception 'executing retention job cannot return to planned';
  end if;
  if new.status = 'completed' and new.completed_at is null then
    raise exception 'completed retention job requires completed_at';
  end if;
  return new;
end
$$;

drop trigger if exists retention_jobs_protect_transition on agent_feed.retention_jobs;
create trigger retention_jobs_protect_transition
before update or delete on agent_feed.retention_jobs
for each row execute function agent_feed.protect_retention_job();

create or replace function agent_feed.protect_retention_job_item()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'retention job items are append-only state records';
  end if;
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.job_id <> old.job_id
     or new.artifact_id <> old.artifact_id
     or new.artifact_key <> old.artifact_key
     or new.storage_ref <> old.storage_ref
     or new.artifact_class <> old.artifact_class
     or new.action <> old.action
     or new.expires_at <> old.expires_at then
    raise exception 'retention job item identity is immutable';
  end if;
  if old.status in ('deleted', 'tombstoned', 'skipped') and new.status <> old.status then
    raise exception 'terminal retention job item is immutable';
  end if;
  if new.status in ('deleted', 'tombstoned', 'skipped', 'failed') and new.result_code is null then
    raise exception 'retention item terminal state requires result_code';
  end if;
  return new;
end
$$;

drop trigger if exists retention_job_items_protect_transition on agent_feed.retention_job_items;
create trigger retention_job_items_protect_transition
before update or delete on agent_feed.retention_job_items
for each row execute function agent_feed.protect_retention_job_item();

create or replace function agent_feed.protect_operations_audit()
returns trigger language plpgsql as $$
begin
  raise exception 'operations audit rows are append-only';
end
$$;

drop trigger if exists operations_audit_append_only on agent_feed.operations_audit;
create trigger operations_audit_append_only
before update or delete on agent_feed.operations_audit
for each row execute function agent_feed.protect_operations_audit();

insert into agent_feed.schema_migrations (version)
values ('0004_operations')
on conflict (version) do nothing;
