\set ON_ERROR_STOP on

-- Milestone 7 is an additive occurrence sidecar.  The protocol 0.1 tables and
-- their legacy liveness trigger remain in place for compatibility; this
-- ledger is the authoritative source for occurrence reads.
create extension if not exists pgcrypto;
create schema if not exists agent_feed;

-- 0002 already installs this unique tenant/internal-id key.  The guarded
-- addition also makes this migration safe against databases that were
-- upgraded from an early 0002 fixture without that constraint.
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

create table if not exists agent_feed.schedule_expectation_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  schedule_key text not null,
  stream_id text not null,
  version integer not null,
  schedule_kind text not null check (schedule_kind in ('interval', 'cron')),
  interval_seconds integer,
  cron_expression text,
  timezone text not null,
  anchor_at timestamptz not null,
  matching_mode text not null check (matching_mode in ('explicit', 'windowed', 'legacy')),
  misfire_policy text not null check (misfire_policy in ('mark_missed', 'fire_latest', 'catch_up')),
  overlap_policy text not null check (overlap_policy in ('allow', 'skip', 'fail_closed')),
  grace_seconds integer not null default 0 check (grace_seconds >= 0),
  enabled boolean not null default true,
  expected_scope jsonb not null default '{}'::jsonb,
  owner text not null,
  notes text not null default '',
  calculator_version text not null default 'agent-feed-occurrence-1',
  tzdata_version text not null default 'database',
  calculator_provenance jsonb not null default '{}'::jsonb,
  tzdata_provenance jsonb not null default '{}'::jsonb,
  -- A legacy stream's existing next_due_at is retained exactly as a baseline;
  -- it is not used as a mutable liveness counter and never creates history.
  baseline_next_due_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, schedule_key, version),
  check (length(tenant_id) between 1 and 256),
  check (length(schedule_key) between 1 and 512),
  check (length(stream_id) between 1 and 512),
  check (version >= 1),
  check (length(timezone) between 1 and 256),
  check (length(owner) between 1 and 256),
  check (
    (schedule_kind = 'interval'
      and interval_seconds is not null
      and interval_seconds > 0
      and cron_expression is null)
    or
    (schedule_kind = 'cron'
      and interval_seconds is null
      and cron_expression is not null
      and cron_expression ~ '^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$')
  ),
  check (cron_expression is null or cron_expression !~ '[@?LWH#]'),
  check (jsonb_typeof(expected_scope) = 'object'),
  check (jsonb_typeof(calculator_provenance) = 'object'),
  check (jsonb_typeof(tzdata_provenance) = 'object')
);

create table if not exists agent_feed.run_trigger_contexts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  run_id uuid not null,
  trigger_kind text not null check (trigger_kind in (
    'scheduled', 'legacy', 'manual', 'test', 'retry', 'replay',
    'backfill', 'event', 'unknown'
  )),
  schedule_version_id uuid,
  trusted_source text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, run_id),
  foreign key (tenant_id, run_id)
    references agent_feed.runs (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, schedule_version_id)
    references agent_feed.schedule_expectation_versions (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(trusted_source) between 1 and 256),
  check (jsonb_typeof(metadata) = 'object'),
  check (
    (trigger_kind in ('scheduled', 'legacy') and schedule_version_id is not null)
    or
    (trigger_kind not in ('scheduled', 'legacy') and schedule_version_id is null)
  )
);

create table if not exists agent_feed.expected_occurrences (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  schedule_version_id uuid not null,
  occurrence_key text not null,
  ordinal bigint not null,
  expected_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, schedule_version_id, id),
  unique (tenant_id, schedule_version_id, occurrence_key),
  unique (tenant_id, schedule_version_id, ordinal),
  foreign key (tenant_id, schedule_version_id)
    references agent_feed.schedule_expectation_versions (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (length(occurrence_key) between 1 and 512),
  check (ordinal >= 0),
  check (window_start <= expected_at and expected_at <= window_end),
  check (window_end >= window_start),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists agent_feed.run_occurrence_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  schedule_version_id uuid not null,
  occurrence_id uuid not null,
  run_id uuid not null,
  trigger_kind text not null check (trigger_kind in (
    'scheduled', 'legacy', 'manual', 'test', 'retry', 'replay',
    'backfill', 'event', 'unknown'
  )),
  matching_mode text not null check (matching_mode in ('explicit', 'windowed', 'legacy')),
  matched_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, occurrence_id),
  unique (tenant_id, run_id),
  foreign key (tenant_id, schedule_version_id)
    references agent_feed.schedule_expectation_versions (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, schedule_version_id, occurrence_id)
    references agent_feed.expected_occurrences (tenant_id, schedule_version_id, id)
    on delete restrict,
  foreign key (tenant_id, run_id)
    references agent_feed.runs (tenant_id, id)
    on delete restrict,
  check (length(tenant_id) between 1 and 256),
  check (jsonb_typeof(metadata) = 'object')
);

-- A stream expectation predates tenant scoping.  When non-default activity
-- exists, guessing which tenant owns it would make occurrence proof unsafe.
-- Keep a deterministic, append-only quarantine receipt instead.
create table if not exists agent_feed.schedule_expectation_migration_quarantine (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  stream_id text not null,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  unique (tenant_id, stream_id),
  check (length(tenant_id) between 1 and 256),
  check (length(stream_id) between 1 and 512),
  check (length(reason) between 1 and 256),
  check (jsonb_typeof(details) = 'object')
);

create index if not exists schedule_expectation_versions_scope_idx
  on agent_feed.schedule_expectation_versions (tenant_id, schedule_key, version desc);
create index if not exists schedule_expectation_versions_stream_idx
  on agent_feed.schedule_expectation_versions (tenant_id, stream_id, version desc);
create index if not exists expected_occurrences_liveness_idx
  on agent_feed.expected_occurrences (tenant_id, schedule_version_id, window_start, window_end, ordinal);
create index if not exists run_occurrence_links_run_idx
  on agent_feed.run_occurrence_links (tenant_id, run_id);
create index if not exists run_trigger_contexts_run_idx
  on agent_feed.run_trigger_contexts (tenant_id, run_id);

-- Version, expected occurrence, link, and quarantine rows are proof records.
-- None can be rewritten or deleted after they are observed by a consumer.
create or replace function agent_feed.protect_occurrence_ledger_row()
returns trigger language plpgsql as $$
begin
  raise exception 'Agent Feed occurrence ledger rows are append-only';
end
$$;

drop trigger if exists schedule_expectation_versions_append_only on agent_feed.schedule_expectation_versions;
create trigger schedule_expectation_versions_append_only
before update or delete on agent_feed.schedule_expectation_versions
for each row execute function agent_feed.protect_occurrence_ledger_row();

drop trigger if exists run_trigger_contexts_append_only on agent_feed.run_trigger_contexts;
create trigger run_trigger_contexts_append_only
before update or delete on agent_feed.run_trigger_contexts
for each row execute function agent_feed.protect_occurrence_ledger_row();

drop trigger if exists expected_occurrences_append_only on agent_feed.expected_occurrences;
create trigger expected_occurrences_append_only
before update or delete on agent_feed.expected_occurrences
for each row execute function agent_feed.protect_occurrence_ledger_row();

drop trigger if exists run_occurrence_links_append_only on agent_feed.run_occurrence_links;
create trigger run_occurrence_links_append_only
before update or delete on agent_feed.run_occurrence_links
for each row execute function agent_feed.protect_occurrence_ledger_row();

drop trigger if exists schedule_expectation_migration_quarantine_append_only on agent_feed.schedule_expectation_migration_quarantine;
create trigger schedule_expectation_migration_quarantine_append_only
before update or delete on agent_feed.schedule_expectation_migration_quarantine
for each row execute function agent_feed.protect_occurrence_ledger_row();

-- Portable database checks for occurrence windows and interval cadence. Cron
-- nominal instants and keys are validated by occurrence-core in the repository;
-- this trigger still prevents hand-written SQL from inserting an arbitrary
-- window or an unaligned interval instant.
create or replace function agent_feed.validate_expected_occurrence()
returns trigger language plpgsql as $$
declare
  schedule_kind_value text;
  interval_value integer;
  anchor_value timestamptz;
  grace_value integer;
  schedule_version_value integer;
  expected_key text;
begin
  select schedule_kind, interval_seconds, anchor_at, grace_seconds, version
    into schedule_kind_value, interval_value, anchor_value, grace_value,
         schedule_version_value
    from agent_feed.schedule_expectation_versions
   where tenant_id = new.tenant_id
     and id = new.schedule_version_id;
  if schedule_kind_value is null then
    raise exception 'expected occurrence schedule version is missing';
  end if;
  if new.window_start <> new.expected_at then
    raise exception 'expected occurrence window_start must equal expected_at';
  end if;
  if new.window_end <> new.expected_at + make_interval(secs => grace_value) then
    raise exception 'expected occurrence window_end must equal expected_at plus grace';
  end if;
  expected_key := 'occ_' || encode(digest(
    format(
      '["%s","%s","%s"]',
      new.schedule_version_id::text,
      schedule_version_value::text,
      to_char(new.expected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'sha256'
  ), 'hex');
  if new.occurrence_key <> expected_key then
    raise exception 'expected occurrence key does not match schedule version and nominal UTC time';
  end if;
  if schedule_kind_value = 'interval' then
    if new.expected_at < anchor_value
       or mod(extract(epoch from (new.expected_at - anchor_value)), interval_value) <> 0 then
      raise exception 'interval expected occurrence is before or unaligned with the immutable anchor';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists expected_occurrences_validate on agent_feed.expected_occurrences;
create trigger expected_occurrences_validate
before insert on agent_feed.expected_occurrences
for each row execute function agent_feed.validate_expected_occurrence();

-- Enforce cross-row matching and trigger policy at the database boundary too;
-- repository validation is intentionally duplicated so direct SQL cannot make
-- a manual or replay run satisfy a scheduled expectation.
create or replace function agent_feed.validate_run_occurrence_link()
returns trigger language plpgsql as $$
declare
  expected_matching_mode text;
  expected_stream_id text;
  run_stream_id text;
  context_trigger_kind text;
  context_schedule_version_id uuid;
  run_started_at timestamptz;
  occurrence_window_start timestamptz;
  occurrence_window_end timestamptz;
begin
  select sv.matching_mode, sv.stream_id, r.stream_id,
         c.trigger_kind, c.schedule_version_id, r.started_at,
         eo.window_start, eo.window_end
    into expected_matching_mode, expected_stream_id, run_stream_id,
         context_trigger_kind, context_schedule_version_id, run_started_at,
         occurrence_window_start, occurrence_window_end
    from agent_feed.expected_occurrences eo
    join agent_feed.schedule_expectation_versions sv
      on sv.tenant_id = eo.tenant_id
     and sv.id = eo.schedule_version_id
    join agent_feed.runs r
      on r.tenant_id = new.tenant_id
     and r.id = new.run_id
    join agent_feed.run_trigger_contexts c
      on c.tenant_id = new.tenant_id
     and c.run_id = new.run_id
   where eo.tenant_id = new.tenant_id
     and eo.id = new.occurrence_id
     and eo.schedule_version_id = new.schedule_version_id;
  if expected_matching_mode is null then
    raise exception 'occurrence, schedule version, run, and trusted trigger context do not belong to the same tenant/version';
  end if;
  if expected_stream_id <> run_stream_id then
    raise exception 'run stream does not match schedule expectation stream';
  end if;
  if context_schedule_version_id <> new.schedule_version_id then
    raise exception 'trusted trigger context schedule version does not match link';
  end if;
  if context_trigger_kind <> new.trigger_kind then
    raise exception 'link trigger kind does not match trusted trigger context';
  end if;
  if new.matching_mode <> expected_matching_mode then
    raise exception 'link matching mode does not match schedule expectation version';
  end if;
  if expected_matching_mode = 'legacy' then
    if new.trigger_kind not in ('legacy', 'scheduled') then
      raise exception 'legacy expectations require a scheduled or legacy trigger';
    end if;
  elsif new.trigger_kind <> 'scheduled' then
    raise exception 'normal expectations require a scheduled trigger';
  end if;
  if new.matching_mode <> 'explicit'
     and run_started_at not between occurrence_window_start and occurrence_window_end then
    raise exception 'run started_at is outside the occurrence window';
  end if;
  return new;
end
$$;

drop trigger if exists run_occurrence_links_validate on agent_feed.run_occurrence_links;
create trigger run_occurrence_links_validate
before insert on agent_feed.run_occurrence_links
for each row execute function agent_feed.validate_run_occurrence_link();

-- Migrate the immutable expectation baseline only.  No historical occurrence
-- is fabricated: callers must explicitly materialize one after this migration.
-- A non-default run makes the old unscoped stream ambiguous and is quarantined.
insert into agent_feed.schedule_expectation_versions (
  tenant_id, schedule_key, stream_id, version, schedule_kind, interval_seconds,
  cron_expression, timezone, anchor_at, matching_mode, misfire_policy,
  overlap_policy, grace_seconds, enabled, expected_scope, owner, notes,
  calculator_version, tzdata_version, calculator_provenance,
  tzdata_provenance, baseline_next_due_at
)
select
  'default', se.stream_id, se.stream_id, 1, 'interval', se.expected_cadence_seconds,
  null, 'UTC', coalesce(se.next_due_at, se.last_terminal_run_at, se.created_at),
  'legacy', 'mark_missed', 'allow', se.grace_seconds, se.enabled,
  coalesce(se.expected_scope, '{}'::jsonb), se.owner,
  case when se.notes = '' then 'Migrated from legacy stream_expectations; materialize occurrences explicitly.'
       else se.notes || ' Migrated from legacy stream_expectations; materialize occurrences explicitly.' end,
  'legacy-stream-expectation', 'legacy',
  jsonb_build_object('source_table', 'agent_feed.stream_expectations', 'migration', '0004_occurrence_ledger'),
  jsonb_build_object('source_table', 'agent_feed.stream_expectations', 'migration', '0004_occurrence_ledger'),
  se.next_due_at
  from agent_feed.stream_expectations se
 where not exists (
   select 1
     from agent_feed.runs r
    where r.stream_id = se.stream_id
      and r.tenant_id <> 'default'
 )
on conflict (tenant_id, schedule_key, version) do nothing;

insert into agent_feed.schedule_expectation_migration_quarantine (
  tenant_id, stream_id, reason, details
)
select 'default', se.stream_id,
       'legacy_stream_has_non_default_tenant_activity',
       jsonb_build_object(
         'non_default_tenants', coalesce((
           select jsonb_agg(distinct r.tenant_id order by r.tenant_id)
             from agent_feed.runs r
            where r.stream_id = se.stream_id
              and r.tenant_id <> 'default'
         ), '[]'::jsonb),
         'source_table', 'agent_feed.stream_expectations',
         'migration', '0004_occurrence_ledger'
       )
  from agent_feed.stream_expectations se
 where exists (
   select 1
     from agent_feed.runs r
    where r.stream_id = se.stream_id
      and r.tenant_id <> 'default'
 )
on conflict (tenant_id, stream_id) do nothing;

create table if not exists agent_feed.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

insert into agent_feed.schema_migrations (version)
values ('0004_occurrence_ledger')
on conflict (version) do nothing;
