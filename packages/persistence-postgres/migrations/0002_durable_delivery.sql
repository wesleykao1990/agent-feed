\set ON_ERROR_STOP on

-- Milestone 2 durable delivery is an additive migration.  Migration 0001 is
-- deliberately retained as the history of the protocol-ingress schema.  The
-- reserved outbox_events table from 0001 is upgraded in place; its
-- delivered_at column is retained only for backwards-compatible inspection
-- and is never used as delivery state because delivery is per consumer.

create extension if not exists pgcrypto;
create schema if not exists agent_feed;

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- A tenant is the isolation boundary for delivery state.  Existing M1 rows
-- are assigned the compatibility tenant "default"; new application code may
-- provide an explicit tenant without changing the protocol version.
alter table agent_feed.runs
  add column if not exists tenant_id text not null default 'default';
alter table agent_feed.runs
  add column if not exists trace_id text;
alter table agent_feed.batches
  add column if not exists tenant_id text not null default 'default';
alter table agent_feed.findings
  add column if not exists tenant_id text not null default 'default';
alter table agent_feed.submitted_evidence
  add column if not exists tenant_id text not null default 'default';
alter table agent_feed.finding_evidence
  add column if not exists tenant_id text not null default 'default';

-- Trace IDs are internal lineage metadata.  They are generated once at run
-- creation and copied to every immutable event/attempt; they are not added to
-- the protocol 0.1 event body.
update agent_feed.runs
   set trace_id = md5(id::text)
 where trace_id is null;
alter table agent_feed.runs
  alter column trace_id set default md5(gen_random_uuid()::text),
  alter column trace_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'runs_trace_id_ck'
       and conrelid = 'agent_feed.runs'::regclass
  ) then
    alter table agent_feed.runs
      add constraint runs_trace_id_ck check (length(trace_id) between 16 and 128) not valid;
  end if;
end
$$;

-- M1's idempotency uniqueness predated tenant isolation. Replace it with a
-- tenant-scoped key so identical producer/stream/idempotency tuples can be
-- accepted independently by two tenants.
do $$
declare
  old_constraint text;
begin
  select c.conname into old_constraint
    from pg_constraint c
   where c.conrelid = 'agent_feed.runs'::regclass
     and c.contype = 'u'
     and pg_get_constraintdef(c.oid) = 'UNIQUE (producer_id, stream_id, begin_idempotency_key)'
   limit 1;
  if old_constraint is not null then
    execute format('alter table agent_feed.runs drop constraint %I', old_constraint);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'runs_tenant_begin_idempotency_key'
       and conrelid = 'agent_feed.runs'::regclass
  ) then
    alter table agent_feed.runs add constraint runs_tenant_begin_idempotency_key
      unique (tenant_id, producer_id, stream_id, begin_idempotency_key);
  end if;
end
$$;

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
  if not exists (
    select 1 from pg_constraint
     where conname = 'batches_tenant_id_id_key'
       and conrelid = 'agent_feed.batches'::regclass
  ) then
    alter table agent_feed.batches
      add constraint batches_tenant_id_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'findings_tenant_id_id_key'
       and conrelid = 'agent_feed.findings'::regclass
  ) then
    alter table agent_feed.findings
      add constraint findings_tenant_id_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'submitted_evidence_tenant_id_id_key'
       and conrelid = 'agent_feed.submitted_evidence'::regclass
  ) then
    alter table agent_feed.submitted_evidence
      add constraint submitted_evidence_tenant_id_id_key unique (tenant_id, id);
  end if;
end
$$;

-- M1's join table has no run_id column.  Composite tenant foreign keys stop
-- cross-tenant links; the scope trigger below additionally stops a new link
-- from joining a finding and evidence belonging to different runs.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'batches_tenant_run_fk'
       and conrelid = 'agent_feed.batches'::regclass
  ) then
    alter table agent_feed.batches
      add constraint batches_tenant_run_fk
      foreign key (tenant_id, run_id)
      references agent_feed.runs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'findings_tenant_run_fk'
       and conrelid = 'agent_feed.findings'::regclass
  ) then
    alter table agent_feed.findings
      add constraint findings_tenant_run_fk
      foreign key (tenant_id, run_id)
      references agent_feed.runs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'submitted_evidence_tenant_run_fk'
       and conrelid = 'agent_feed.submitted_evidence'::regclass
  ) then
    alter table agent_feed.submitted_evidence
      add constraint submitted_evidence_tenant_run_fk
      foreign key (tenant_id, run_id)
      references agent_feed.runs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'finding_evidence_tenant_finding_fk'
       and conrelid = 'agent_feed.finding_evidence'::regclass
  ) then
    alter table agent_feed.finding_evidence
      add constraint finding_evidence_tenant_finding_fk
      foreign key (tenant_id, finding_id)
      references agent_feed.findings (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'finding_evidence_tenant_evidence_fk'
       and conrelid = 'agent_feed.finding_evidence'::regclass
  ) then
    alter table agent_feed.finding_evidence
      add constraint finding_evidence_tenant_evidence_fk
      foreign key (tenant_id, evidence_id)
      references agent_feed.submitted_evidence (tenant_id, id)
      not valid;
  end if;
end
$$;

-- Upgrade the reserved M1 outbox.  Nullable additions are backfilled before
-- NOT NULL is applied so a pre-existing reserved row is not silently dropped.
alter table agent_feed.outbox_events
  add column if not exists tenant_id text not null default 'default';
alter table agent_feed.outbox_events
  add column if not exists event_id text default (gen_random_uuid()::text);
alter table agent_feed.outbox_events
  add column if not exists event_key text;
alter table agent_feed.outbox_events
  add column if not exists protocol_version text default '0.1';
alter table agent_feed.outbox_events
  add column if not exists occurred_at timestamptz;
alter table agent_feed.outbox_events
  add column if not exists payload_hash text;
alter table agent_feed.outbox_events
  add column if not exists stream_position bigint;
alter table agent_feed.outbox_events
  add column if not exists delivery_position bigint;
alter table agent_feed.outbox_events
  add column if not exists delivery_eligibility text;
alter table agent_feed.outbox_events
  add column if not exists quarantine_reason text;
alter table agent_feed.outbox_events
  add column if not exists trace_id text;
alter table agent_feed.outbox_events
  add column if not exists wire_finding_id text;
alter table agent_feed.outbox_events
  add column if not exists finding_type text;
alter table agent_feed.outbox_events
  add column if not exists routing_tags jsonb not null default '[]'::jsonb;

-- A previous 0002 foundation may already have installed the append-only
-- trigger before these additive backfills were introduced.  Temporarily
-- disable only that trigger while normalizing legacy null columns; the
-- immutable trigger is recreated/enabled below before application writes.
do $$
begin
  if exists (
    select 1 from pg_trigger
     where tgname = 'outbox_events_append_only'
       and tgrelid = 'agent_feed.outbox_events'::regclass
       and not tgisinternal
  ) then
    alter table agent_feed.outbox_events disable trigger outbox_events_append_only;
  end if;
end
$$;

update agent_feed.outbox_events
   set event_id = coalesce(event_id, id::text)
 where event_id is null;
update agent_feed.outbox_events
   set event_key = event_id
 where event_key is null;
update agent_feed.outbox_events
   set protocol_version = '0.1'
 where protocol_version is null;
update agent_feed.outbox_events
   set occurred_at = created_at
 where occurred_at is null;
update agent_feed.outbox_events
   set payload_hash = encode(digest(convert_to(payload::text, 'utf8'), 'sha256'), 'hex')
 where payload_hash is null;
-- Rows that existed before M2 have no security classification.  They remain
-- auditable but are quarantined until an explicit application decision marks
-- them eligible.  New validated events default to eligible below.
update agent_feed.outbox_events
   set delivery_eligibility = 'quarantined'
 where delivery_eligibility is null;
update agent_feed.outbox_events
   set trace_id = md5(id::text || run_id::text)
 where trace_id is null;
update agent_feed.outbox_events
   set wire_finding_id = finding_id::text
 where wire_finding_id is null and finding_id is not null;
update agent_feed.outbox_events
   set finding_type = payload ->> 'finding_type'
 where finding_type is null and finding_id is not null;

-- Allocate a stable, monotonic cursor independently for each tenant/stream.
-- Gaps are acceptable: a failed idempotent insert may consume a position, but
-- positions never move backwards or get reused.
create table if not exists agent_feed.stream_event_counters (
  tenant_id text not null,
  stream_id text not null,
  last_position bigint not null check (last_position >= 0),
  primary key (tenant_id, stream_id)
);

with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, stream_id
           order by created_at, id
         )::bigint as stream_position
    from agent_feed.outbox_events
   where stream_position is null
)
update agent_feed.outbox_events event
   set stream_position = ranked.stream_position
  from ranked
 where event.id = ranked.id
   and event.stream_position is null;

-- `stream_position` is retained for M1 compatibility.  Delivery cursors and
-- selector activation use this tenant-global position so one subscription can
-- safely combine several streams without an activation vector.
with ranked as (
  select id,
         row_number() over (
           partition by tenant_id
           order by coalesce(occurred_at, created_at), id
         )::bigint as delivery_position
    from agent_feed.outbox_events
   where delivery_position is null
)
update agent_feed.outbox_events event
   set delivery_position = ranked.delivery_position
  from ranked
 where event.id = ranked.id
   and event.delivery_position is null;

insert into agent_feed.stream_event_counters (tenant_id, stream_id, last_position)
select tenant_id, stream_id, max(stream_position)
  from agent_feed.outbox_events
 group by tenant_id, stream_id
on conflict (tenant_id, stream_id) do update
  set last_position = greatest(
    agent_feed.stream_event_counters.last_position,
    excluded.last_position
  );

create table if not exists agent_feed.tenant_event_counters (
  tenant_id text primary key,
  last_position bigint not null check (last_position >= 0)
);

insert into agent_feed.tenant_event_counters (tenant_id, last_position)
select tenant_id, max(delivery_position)
  from agent_feed.outbox_events
 group by tenant_id
on conflict (tenant_id) do update
  set last_position = greatest(
    agent_feed.tenant_event_counters.last_position,
    excluded.last_position
  );

alter table agent_feed.outbox_events
  alter column event_id set not null,
  alter column event_key set not null,
  alter column protocol_version set not null,
  alter column occurred_at set not null,
  alter column payload_hash set not null,
  alter column stream_position set not null,
  alter column delivery_position set not null,
  alter column delivery_eligibility set not null,
  alter column trace_id set not null,
  alter column delivery_eligibility set default 'eligible';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_tenant_event_id_key'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_tenant_event_id_key unique (tenant_id, event_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_delivery_position_key'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_delivery_position_key
      unique (tenant_id, delivery_position);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_tenant_event_key_key'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_tenant_event_key_key unique (tenant_id, event_key);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_stream_position_key'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_stream_position_key
      unique (tenant_id, stream_id, stream_position);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_tenant_run_fk'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_tenant_run_fk
      foreign key (tenant_id, run_id)
      references agent_feed.runs (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_tenant_finding_fk'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_tenant_finding_fk
      foreign key (tenant_id, finding_id)
      references agent_feed.findings (tenant_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_protocol_version_ck'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_protocol_version_ck
      check (protocol_version = '0.1') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_event_type_ck'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_event_type_ck
      check (event_type in (
        'run.started', 'finding.submitted', 'run.completed',
        'run.partial', 'run.failed'
      )) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_eligibility_ck'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_eligibility_ck
      check (delivery_eligibility in ('eligible', 'quarantined')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_position_ck'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_position_ck
      check (stream_position >= 1) not valid;
  end if;
end
$$;

create or replace function agent_feed.next_stream_event_position(
  p_tenant_id text,
  p_stream_id text
)
returns bigint
language plpgsql
as $$
declare
  allocated bigint;
begin
  insert into agent_feed.stream_event_counters (tenant_id, stream_id, last_position)
       values (p_tenant_id, p_stream_id, 1)
  on conflict (tenant_id, stream_id) do update
        set last_position = agent_feed.stream_event_counters.last_position + 1
  returning last_position into allocated;
  return allocated;
end
$$;

create or replace function agent_feed.next_tenant_event_position(p_tenant_id text)
returns bigint
language plpgsql
as $$
declare
  allocated bigint;
begin
  insert into agent_feed.tenant_event_counters (tenant_id, last_position)
       values (p_tenant_id, 1)
  on conflict (tenant_id) do update
        set last_position = agent_feed.tenant_event_counters.last_position + 1
  returning last_position into allocated;
  return allocated;
end
$$;

create or replace function agent_feed.set_outbox_event_defaults()
returns trigger
language plpgsql
as $$
begin
  new.tenant_id := coalesce(nullif(new.tenant_id, ''), 'default');
  new.event_id := coalesce(nullif(new.event_id, ''), gen_random_uuid()::text);
  new.event_key := coalesce(nullif(new.event_key, ''), new.event_id);
  new.protocol_version := coalesce(new.protocol_version, '0.1');
  new.occurred_at := coalesce(new.occurred_at, new.created_at, now());
  new.trace_id := coalesce(nullif(new.trace_id, ''), md5(gen_random_uuid()::text));
  new.wire_finding_id := coalesce(nullif(new.wire_finding_id, ''), new.finding_id::text);
  new.finding_type := coalesce(nullif(new.finding_type, ''), new.payload ->> 'finding_type');
  new.routing_tags := coalesce(new.routing_tags, new.payload -> 'routing_tags', '[]'::jsonb);
  new.payload_hash := coalesce(
    nullif(new.payload_hash, ''),
    encode(digest(convert_to(new.payload::text, 'utf8'), 'sha256'), 'hex')
  );
  new.delivery_eligibility := coalesce(new.delivery_eligibility, 'eligible');
  new.delivery_position := agent_feed.next_tenant_event_position(new.tenant_id);
  -- Keep the historical per-stream cursor populated for old readers.  The
  -- durable delivery repository orders and activates by delivery_position.
  new.stream_position := agent_feed.next_stream_event_position(new.tenant_id, new.stream_id);
  return new;
end
$$;

drop trigger if exists outbox_events_set_defaults on agent_feed.outbox_events;
create trigger outbox_events_set_defaults
before insert on agent_feed.outbox_events
for each row execute function agent_feed.set_outbox_event_defaults();

create or replace function agent_feed.protect_outbox_event()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Agent Feed outbox events are immutable';
end
$$;

drop trigger if exists outbox_events_append_only on agent_feed.outbox_events;
create trigger outbox_events_append_only
before update or delete on agent_feed.outbox_events
for each row execute function agent_feed.protect_outbox_event();

alter table agent_feed.outbox_events enable trigger outbox_events_append_only;

create or replace function agent_feed.assert_outbox_event_scope()
returns trigger
language plpgsql
as $$
declare
  run_tenant text;
  run_stream text;
  finding_run uuid;
  finding_tenant text;
begin
  select tenant_id, stream_id into run_tenant, run_stream
    from agent_feed.runs where id = new.run_id;
  if run_tenant is null then
    raise exception 'outbox event run does not exist';
  end if;
  if new.tenant_id <> run_tenant or new.stream_id <> run_stream then
    raise exception 'outbox event crosses run or tenant scope';
  end if;
  if new.finding_id is not null then
    select run_id, tenant_id into finding_run, finding_tenant
      from agent_feed.findings where id = new.finding_id;
    if finding_run is null or finding_run <> new.run_id or finding_tenant <> new.tenant_id then
      raise exception 'outbox finding crosses run or tenant scope';
    end if;
  end if;
  return new;
end
$$;

-- The z-prefix makes this guard run after set_outbox_event_defaults under
-- PostgreSQL's name ordering for triggers on the same table.
drop trigger if exists outbox_events_scope_guard on agent_feed.outbox_events;
drop trigger if exists outbox_events_z_scope_guard on agent_feed.outbox_events;
create trigger outbox_events_z_scope_guard
before insert on agent_feed.outbox_events
for each row execute function agent_feed.assert_outbox_event_scope();

create or replace function agent_feed.protect_run_tenant_scope()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id <> old.tenant_id then
    raise exception 'run tenant scope is immutable';
  end if;
  if new.trace_id <> old.trace_id then
    raise exception 'run trace lineage is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists runs_protect_tenant_scope on agent_feed.runs;
create trigger runs_protect_tenant_scope
before update on agent_feed.runs
for each row execute function agent_feed.protect_run_tenant_scope();

create or replace function agent_feed.protect_finding_evidence_scope()
returns trigger
language plpgsql
as $$
declare
  finding_run uuid;
  finding_tenant text;
  evidence_run uuid;
  evidence_tenant text;
begin
  select run_id, tenant_id into finding_run, finding_tenant
    from agent_feed.findings where id = new.finding_id;
  select run_id, tenant_id into evidence_run, evidence_tenant
    from agent_feed.submitted_evidence where id = new.evidence_id;
  if finding_run is null or evidence_run is null then
    raise exception 'finding/evidence reference must resolve';
  end if;
  if finding_run <> evidence_run or finding_tenant <> evidence_tenant
     or new.tenant_id <> finding_tenant then
    raise exception 'finding/evidence reference crosses run or tenant scope';
  end if;
  return new;
end
$$;

drop trigger if exists finding_evidence_protect_scope on agent_feed.finding_evidence;
create trigger finding_evidence_protect_scope
before insert on agent_feed.finding_evidence
for each row execute function agent_feed.protect_finding_evidence_scope();

-- Consumer subscriptions are selectors, not protocol-domain objects.  A
-- secret is referenced by ID only; secret material stays in a vault/runtime.
create table if not exists agent_feed.consumer_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  name text not null default 'unnamed',
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  selector_hash text not null default '',
  stream_id text not null,
  finding_type text,
  routing_tag text,
  selector_version integer not null default 1 check (selector_version >= 1),
  delivery_mode text not null check (delivery_mode in ('webhook', 'pull')),
  endpoint_url text,
  signing_secret_ref text,
  enabled boolean not null default true,
  starts_at timestamptz not null default now(),
  cursor_created_at timestamptz,
  cursor_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consumer_subscriptions_tenant_id_key unique (tenant_id, id),
  constraint consumer_subscriptions_tenant_consumer_id_key unique (tenant_id, consumer_id, id),
  check (length(tenant_id) > 0),
  check (length(consumer_id) > 0),
  check (length(stream_id) > 0),
  check (
    (delivery_mode = 'webhook' and endpoint_url is not null)
    or (delivery_mode = 'pull' and endpoint_url is null)
  ),
  check (delivery_mode <> 'webhook' or signing_secret_ref is not null)
);

-- The original M2 foundation kept one selector per subscription.  These
-- additive columns preserve that compatibility surface while the normalized
-- version tables below provide immutable, future-effective selector history.
alter table agent_feed.consumer_subscriptions
  add column if not exists name text not null default 'unnamed';
alter table agent_feed.consumer_subscriptions
  add column if not exists status text not null default 'active';
alter table agent_feed.consumer_subscriptions
  add column if not exists selector_hash text not null default '';
alter table agent_feed.consumer_subscriptions
  add column if not exists include_run_events boolean not null default true;
alter table agent_feed.consumer_subscriptions
  add column if not exists event_types jsonb not null default
    '["run.started","finding.submitted","run.completed","run.partial","run.failed"]'::jsonb;
alter table agent_feed.consumer_subscriptions
  add column if not exists routing_tag_match text not null default 'any';
alter table agent_feed.consumer_subscriptions
  add column if not exists selector_updated_at timestamptz not null default now();

update agent_feed.consumer_subscriptions
   set name = 'subscription-' || id::text
 where name is null or length(name) = 0;
update agent_feed.consumer_subscriptions
   set status = case when enabled then 'active' else 'paused' end
 where status = 'active' and not enabled;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_subscriptions_event_types_ck'
       and conrelid = 'agent_feed.consumer_subscriptions'::regclass
  ) then
    alter table agent_feed.consumer_subscriptions add constraint
      consumer_subscriptions_event_types_ck check (jsonb_typeof(event_types) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_subscriptions_routing_tag_match_ck'
       and conrelid = 'agent_feed.consumer_subscriptions'::regclass
  ) then
    alter table agent_feed.consumer_subscriptions add constraint
      consumer_subscriptions_routing_tag_match_ck check (routing_tag_match in ('any', 'all'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_subscriptions_status_ck'
       and conrelid = 'agent_feed.consumer_subscriptions'::regclass
  ) then
    alter table agent_feed.consumer_subscriptions add constraint
      consumer_subscriptions_status_ck check (status in ('active', 'paused', 'revoked'));
  end if;
end
$$;

-- The legacy one-selector uniqueness index is unsafe once a normalized
-- subscription can contain multiple streams/types/tags: it compares only the
-- first compatibility column and can reject two distinct selector sets.  The
-- parent identity is already unique by tenant+consumer+id; selector-version
-- rows own selector history and matching uniqueness.
drop index if exists agent_feed.consumer_subscriptions_selector_uidx;

create index if not exists consumer_subscriptions_stream_idx
  on agent_feed.consumer_subscriptions (tenant_id, stream_id, enabled);

create index if not exists consumer_subscriptions_scope_idx
  on agent_feed.consumer_subscriptions (tenant_id, consumer_id, status, created_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_subscriptions_tenant_consumer_id_key'
       and conrelid = 'agent_feed.consumer_subscriptions'::regclass
  ) then
    alter table agent_feed.consumer_subscriptions
      add constraint consumer_subscriptions_tenant_consumer_id_key
      unique (tenant_id, consumer_id, id);
  end if;
end
$$;

create or replace function agent_feed.protect_consumer_subscription_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'consumer subscriptions are disabled, not deleted';
  end if;
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.consumer_id <> old.consumer_id
     or new.stream_id <> old.stream_id
     or new.finding_type is distinct from old.finding_type
     or new.routing_tag is distinct from old.routing_tag
     or new.selector_version <> old.selector_version then
    raise exception 'consumer subscription identity is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists consumer_subscriptions_protect_identity on agent_feed.consumer_subscriptions;
create trigger consumer_subscriptions_protect_identity
before update or delete on agent_feed.consumer_subscriptions
for each row execute function agent_feed.protect_consumer_subscription_identity();

-- Normalized selector history.  A subscription update creates a new version;
-- it never mutates the selector used by an already accepted event.  Empty
-- selector-kind sets are intentional wildcards for adapters that need them;
-- the public delivery-core contract may require an explicit stream/event list.
create table if not exists agent_feed.consumer_subscription_versions (
  tenant_id text not null default 'default',
  consumer_id text not null,
  subscription_id uuid not null,
  selector_version integer not null check (selector_version >= 1),
  active_from timestamptz not null default now(),
  activation_position bigint not null default 0 check (activation_position >= 0),
  active_until timestamptz,
  selector_hash text not null default '',
  include_run_events boolean not null default true,
  active boolean not null default true,
  delivery_mode text not null check (delivery_mode in ('webhook', 'pull')),
  endpoint_url text,
  signing_secret_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, consumer_id, subscription_id, selector_version),
  unique (tenant_id, subscription_id, selector_version),
  check (length(tenant_id) > 0),
  check (length(consumer_id) > 0),
  check (active_until is null or active_until > active_from),
  check ((delivery_mode = 'webhook' and endpoint_url is not null and signing_secret_ref is not null)
      or (delivery_mode = 'pull' and endpoint_url is null))
);

create table if not exists agent_feed.consumer_subscription_selectors (
  tenant_id text not null default 'default',
  consumer_id text not null,
  subscription_id uuid not null,
  selector_version integer not null,
  selector_kind text not null check (selector_kind in ('stream_id', 'finding_type', 'routing_tag', 'event_type')),
  selector_value text not null,
  match_mode text not null default 'any' check (match_mode in ('any', 'all')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, consumer_id, subscription_id, selector_version, selector_kind, selector_value),
  check (length(selector_value) > 0),
  check (selector_kind = 'routing_tag' or match_mode = 'any')
);

alter table agent_feed.consumer_subscription_versions
  add column if not exists selector_hash text not null default '';
alter table agent_feed.consumer_subscription_versions
  add column if not exists activation_position bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'subscription_versions_subscription_fk'
       and conrelid = 'agent_feed.consumer_subscription_versions'::regclass
  ) then
    alter table agent_feed.consumer_subscription_versions
      add constraint subscription_versions_subscription_fk
      foreign key (tenant_id, consumer_id, subscription_id)
      references agent_feed.consumer_subscriptions (tenant_id, consumer_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'subscription_selectors_version_fk'
       and conrelid = 'agent_feed.consumer_subscription_selectors'::regclass
  ) then
    alter table agent_feed.consumer_subscription_selectors
      add constraint subscription_selectors_version_fk
      foreign key (tenant_id, consumer_id, subscription_id, selector_version)
      references agent_feed.consumer_subscription_versions
        (tenant_id, consumer_id, subscription_id, selector_version)
      not valid;
  end if;
end
$$;

create index if not exists subscription_versions_active_idx
  on agent_feed.consumer_subscription_versions
    (tenant_id, consumer_id, active, active_from, active_until);
create index if not exists subscription_selectors_lookup_idx
  on agent_feed.consumer_subscription_selectors
    (tenant_id, selector_kind, selector_value, match_mode);

-- Upgrade legacy M2 rows to selector version 1 exactly once.  Subsequent
-- migration runs are no-ops, which is important when a worker starts against
-- a database that was partially upgraded.
insert into agent_feed.consumer_subscription_versions (
  tenant_id, consumer_id, subscription_id, selector_version, active_from,
  activation_position,
  selector_hash,
  include_run_events, active, delivery_mode, endpoint_url, signing_secret_ref
)
select s.tenant_id, s.consumer_id, s.id, s.selector_version, s.starts_at,
       coalesce((select max(e.delivery_position) from agent_feed.outbox_events e where e.tenant_id = s.tenant_id), 0),
       s.selector_hash,
       s.include_run_events, s.enabled, s.delivery_mode, s.endpoint_url,
       s.signing_secret_ref
  from agent_feed.consumer_subscriptions s
 where not exists (
   select 1 from agent_feed.consumer_subscription_versions v
    where v.tenant_id = s.tenant_id
      and v.consumer_id = s.consumer_id
      and v.subscription_id = s.id
      and v.selector_version = s.selector_version
 );

insert into agent_feed.consumer_subscription_selectors (
  tenant_id, consumer_id, subscription_id, selector_version, selector_kind,
  selector_value, match_mode
)
select s.tenant_id, s.consumer_id, s.id, s.selector_version, 'stream_id', s.stream_id, 'any'
  from agent_feed.consumer_subscriptions s
 where s.stream_id is not null and length(s.stream_id) > 0
on conflict do nothing;
insert into agent_feed.consumer_subscription_selectors (
  tenant_id, consumer_id, subscription_id, selector_version, selector_kind,
  selector_value, match_mode
)
select s.tenant_id, s.consumer_id, s.id, s.selector_version, 'finding_type', s.finding_type, 'any'
  from agent_feed.consumer_subscriptions s
 where s.finding_type is not null and length(s.finding_type) > 0
on conflict do nothing;
insert into agent_feed.consumer_subscription_selectors (
  tenant_id, consumer_id, subscription_id, selector_version, selector_kind,
  selector_value, match_mode
)
select s.tenant_id, s.consumer_id, s.id, s.selector_version, 'routing_tag', s.routing_tag,
       s.routing_tag_match
  from agent_feed.consumer_subscriptions s
 where s.routing_tag is not null and length(s.routing_tag) > 0
on conflict do nothing;
insert into agent_feed.consumer_subscription_selectors (
  tenant_id, consumer_id, subscription_id, selector_version, selector_kind,
  selector_value, match_mode
)
select s.tenant_id, s.consumer_id, s.id, s.selector_version, 'event_type', event_type, 'any'
  from agent_feed.consumer_subscriptions s
 cross join lateral jsonb_array_elements_text(s.event_types) as event_type
 where jsonb_typeof(s.event_types) = 'array'
on conflict do nothing;

-- A delivery row is the durable fan-out queue item.  It is intentionally
-- separate from outbox_events because one event can have many consumers.
create table if not exists agent_feed.consumer_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  subscription_id uuid not null,
  selector_version integer not null default 1 check (selector_version >= 1),
  event_id text not null,
  state text not null default 'pending'
    check (state in ('pending', 'in_flight', 'retry_wait', 'acknowledged', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts >= 1),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_owner text,
  acknowledged_at timestamptz,
  dead_lettered_at timestamptz,
  dead_letter_reason text,
  last_error_code text,
  last_error_detail text,
  replay_count integer not null default 0 check (replay_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, consumer_id, id),
  unique (tenant_id, subscription_id, event_id),
  check (length(tenant_id) > 0),
  check (length(consumer_id) > 0),
  check (
    (state = 'in_flight' and lease_token is not null and lease_expires_at is not null)
    or state <> 'in_flight'
  ),
  check (state <> 'acknowledged' or acknowledged_at is not null),
  check (state <> 'dead_letter' or (dead_lettered_at is not null and dead_letter_reason is not null))
);

alter table agent_feed.consumer_deliveries
  add column if not exists selector_version integer not null default 1;
alter table agent_feed.consumer_deliveries
  add column if not exists lease_owner text;
alter table agent_feed.consumer_deliveries
  add column if not exists last_error_code text;
alter table agent_feed.consumer_deliveries
  add column if not exists last_error_detail text;
alter table agent_feed.consumer_deliveries
  alter column max_attempts set default 5;

create index if not exists consumer_deliveries_claim_idx
  on agent_feed.consumer_deliveries (tenant_id, state, next_attempt_at)
  where state in ('pending', 'retry_wait');
create index if not exists consumer_deliveries_consumer_idx
  on agent_feed.consumer_deliveries (tenant_id, consumer_id, state, created_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_deliveries_selector_version_fk'
       and conrelid = 'agent_feed.consumer_deliveries'::regclass
  ) then
    alter table agent_feed.consumer_deliveries
      add constraint consumer_deliveries_selector_version_fk
      foreign key (tenant_id, consumer_id, subscription_id, selector_version)
      references agent_feed.consumer_subscription_versions
        (tenant_id, consumer_id, subscription_id, selector_version)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_deliveries_subscription_fk'
       and conrelid = 'agent_feed.consumer_deliveries'::regclass
  ) then
    alter table agent_feed.consumer_deliveries
      add constraint consumer_deliveries_subscription_fk
      foreign key (tenant_id, consumer_id, subscription_id)
      references agent_feed.consumer_subscriptions (tenant_id, consumer_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'consumer_deliveries_event_fk'
       and conrelid = 'agent_feed.consumer_deliveries'::regclass
  ) then
    alter table agent_feed.consumer_deliveries
      add constraint consumer_deliveries_event_fk
      foreign key (tenant_id, event_id)
      references agent_feed.outbox_events (tenant_id, event_id)
      not valid;
  end if;
end
$$;

create or replace function agent_feed.protect_consumer_delivery_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'consumer delivery rows are never deleted';
  end if;
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.consumer_id <> old.consumer_id
     or new.subscription_id <> old.subscription_id
     or new.selector_version <> old.selector_version
     or new.event_id <> old.event_id
     or new.created_at <> old.created_at then
    raise exception 'consumer delivery identity is immutable';
  end if;
  if old.state = 'acknowledged' and new.state <> 'acknowledged' then
    raise exception 'acknowledged delivery is terminal';
  end if;
  if old.state = 'dead_letter' and new.state <> 'pending' then
    raise exception 'dead-letter delivery can only be replayed to pending';
  end if;
  -- Pull consumers acknowledge queued rows directly.  Webhook rows must
  -- still pass through an in-flight lease, so this exception is deliberately
  -- scoped to the immutable subscription-version delivery mode.
  if old.state in ('pending', 'retry_wait') and new.state = 'acknowledged' then
    if not exists (
      select 1
        from agent_feed.consumer_subscription_versions v
       where v.tenant_id = old.tenant_id
         and v.consumer_id = old.consumer_id
         and v.subscription_id = old.subscription_id
         and v.selector_version = old.selector_version
         and v.delivery_mode = 'pull'
    ) then
      raise exception 'queued acknowledgement requires a pull subscription';
    end if;
  end if;
  if old.state = 'pending'
     and new.state not in ('pending', 'in_flight', 'retry_wait', 'acknowledged', 'dead_letter') then
    raise exception 'invalid pending delivery transition';
  end if;
  if old.state = 'in_flight'
     and new.state not in ('in_flight', 'retry_wait', 'acknowledged', 'dead_letter') then
    raise exception 'invalid in-flight delivery transition';
  end if;
  if old.state = 'retry_wait'
     and new.state not in ('retry_wait', 'in_flight', 'acknowledged', 'dead_letter') then
    raise exception 'invalid retry delivery transition';
  end if;
  return new;
end
$$;

drop trigger if exists consumer_deliveries_protect_transition on agent_feed.consumer_deliveries;
create trigger consumer_deliveries_protect_transition
before update or delete on agent_feed.consumer_deliveries
for each row execute function agent_feed.protect_consumer_delivery_transition();

create table if not exists agent_feed.delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  delivery_id uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  attempt_kind text not null check (attempt_kind in ('initial', 'retry', 'replay')),
  state text not null default 'in_flight'
    check (state in ('in_flight', 'succeeded', 'failed', 'expired', 'dead_lettered')),
  worker_id text,
  request_timestamp timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  request_body_hash text,
  signature text,
  signing_secret_ref text,
  http_status integer check (http_status is null or (http_status between 100 and 599)),
  response_hash text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, delivery_id, attempt_number),
  check (finished_at is null or finished_at >= started_at),
  check (state = 'in_flight' or finished_at is not null)
);

alter table agent_feed.delivery_attempts
  add column if not exists worker_id text;

create index if not exists delivery_attempts_delivery_idx
  on agent_feed.delivery_attempts (tenant_id, consumer_id, delivery_id, attempt_number desc);
create index if not exists delivery_attempts_state_idx
  on agent_feed.delivery_attempts (tenant_id, state, started_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'delivery_attempts_delivery_fk'
       and conrelid = 'agent_feed.delivery_attempts'::regclass
  ) then
    alter table agent_feed.delivery_attempts
      add constraint delivery_attempts_delivery_fk
      foreign key (tenant_id, consumer_id, delivery_id)
      references agent_feed.consumer_deliveries (tenant_id, consumer_id, id)
      not valid;
  end if;
end
$$;

create or replace function agent_feed.protect_delivery_attempt()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'delivery attempts are append-only';
  end if;
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.consumer_id <> old.consumer_id
     or new.delivery_id <> old.delivery_id
     or new.attempt_number <> old.attempt_number
     or new.attempt_kind <> old.attempt_kind
     or new.started_at <> old.started_at
     or new.created_at <> old.created_at then
    raise exception 'delivery attempt identity is immutable';
  end if;
  if old.state <> 'in_flight' then
    raise exception 'completed delivery attempts are immutable';
  end if;
  if new.state = 'in_flight' or new.finished_at is null then
    raise exception 'delivery attempt completion requires a terminal state and timestamp';
  end if;
  return new;
end
$$;

drop trigger if exists delivery_attempts_append_only on agent_feed.delivery_attempts;
create trigger delivery_attempts_append_only
before update or delete on agent_feed.delivery_attempts
for each row execute function agent_feed.protect_delivery_attempt();

create table if not exists agent_feed.acknowledgements (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  subscription_id uuid not null,
  delivery_id uuid not null,
  event_id text not null,
  attempt_number integer not null check (attempt_number >= 1),
  acknowledgement_key text not null,
  acknowledgement_payload_hash text not null,
  consumer_receipt jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, subscription_id, event_id),
  unique (tenant_id, subscription_id, acknowledgement_key),
  check (length(acknowledgement_key) >= 8)
);

create index if not exists acknowledgements_consumer_idx
  on agent_feed.acknowledgements (tenant_id, consumer_id, acknowledged_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'acknowledgements_delivery_fk'
       and conrelid = 'agent_feed.acknowledgements'::regclass
  ) then
    alter table agent_feed.acknowledgements
      add constraint acknowledgements_delivery_fk
      foreign key (tenant_id, consumer_id, delivery_id)
      references agent_feed.consumer_deliveries (tenant_id, consumer_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'acknowledgements_subscription_fk'
       and conrelid = 'agent_feed.acknowledgements'::regclass
  ) then
    alter table agent_feed.acknowledgements
      add constraint acknowledgements_subscription_fk
      foreign key (tenant_id, consumer_id, subscription_id)
      references agent_feed.consumer_subscriptions (tenant_id, consumer_id, id)
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'acknowledgements_event_fk'
       and conrelid = 'agent_feed.acknowledgements'::regclass
  ) then
    alter table agent_feed.acknowledgements
      add constraint acknowledgements_event_fk
      foreign key (tenant_id, event_id)
      references agent_feed.outbox_events (tenant_id, event_id)
      not valid;
  end if;
end
$$;

create or replace function agent_feed.protect_delivery_audit_row()
returns trigger
language plpgsql
as $$
begin
  raise exception 'delivery audit rows are append-only';
end
$$;

drop trigger if exists acknowledgements_append_only on agent_feed.acknowledgements;
create trigger acknowledgements_append_only
before update or delete on agent_feed.acknowledgements
for each row execute function agent_feed.protect_delivery_audit_row();

-- One consumer acknowledgement command can cover many delivery rows.  The
-- per-delivery acknowledgement table remains an audit/receipt table, while
-- this command ledger is the authoritative idempotency boundary for bulk ACK
-- requests.  The stored result is immutable so a retry returns exactly the
-- same delivery set and acknowledgement ID.
create table if not exists agent_feed.acknowledgement_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  subscription_id uuid not null,
  idempotency_key text not null,
  payload_hash text not null,
  acknowledgement_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, subscription_id, idempotency_key),
  unique (tenant_id, consumer_id, subscription_id, acknowledgement_id),
  check (length(tenant_id) > 0),
  check (length(consumer_id) > 0),
  check (length(idempotency_key) >= 1),
  check (jsonb_typeof(result) = 'object')
);

create index if not exists acknowledgement_commands_scope_idx
  on agent_feed.acknowledgement_commands
    (tenant_id, consumer_id, subscription_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'acknowledgement_commands_subscription_fk'
       and conrelid = 'agent_feed.acknowledgement_commands'::regclass
  ) then
    alter table agent_feed.acknowledgement_commands
      add constraint acknowledgement_commands_subscription_fk
      foreign key (tenant_id, consumer_id, subscription_id)
      references agent_feed.consumer_subscriptions (tenant_id, consumer_id, id)
      not valid;
  end if;
end
$$;

drop trigger if exists acknowledgement_commands_append_only on agent_feed.acknowledgement_commands;
create trigger acknowledgement_commands_append_only
before update or delete on agent_feed.acknowledgement_commands
for each row execute function agent_feed.protect_delivery_audit_row();

-- Replay is an auditable command, not an update to the immutable event.  The
-- worker changes a dead-letter delivery to pending and creates a new attempt.
create table if not exists agent_feed.delivery_replays (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  consumer_id text not null,
  delivery_id uuid not null,
  replay_idempotency_key text not null,
  request_hash text not null,
  requested_by text not null,
  reason text not null,
  replay_generation integer not null check (replay_generation >= 1),
  requested_at timestamptz not null default now(),
  unique (tenant_id, consumer_id, delivery_id, replay_idempotency_key),
  unique (tenant_id, consumer_id, delivery_id, replay_generation),
  check (length(replay_idempotency_key) >= 8),
  check (length(requested_by) > 0),
  check (length(reason) > 0)
);

create index if not exists delivery_replays_delivery_idx
  on agent_feed.delivery_replays (tenant_id, consumer_id, delivery_id, requested_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'delivery_replays_delivery_fk'
       and conrelid = 'agent_feed.delivery_replays'::regclass
  ) then
    alter table agent_feed.delivery_replays
      add constraint delivery_replays_delivery_fk
      foreign key (tenant_id, consumer_id, delivery_id)
      references agent_feed.consumer_deliveries (tenant_id, consumer_id, id)
      not valid;
  end if;
end
$$;

drop trigger if exists delivery_replays_append_only on agent_feed.delivery_replays;
create trigger delivery_replays_append_only
before update or delete on agent_feed.delivery_replays
for each row execute function agent_feed.protect_delivery_audit_row();

insert into agent_feed.schema_migrations (version)
values ('0002_durable_delivery')
on conflict (version) do nothing;
