\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

create schema if not exists agent_feed;

-- The persisted envelope is the protocol-shaped source record. Mutable
-- completion fields are duplicated as columns so they can be locked and
-- constrained without making consumers query JSON.
create table if not exists agent_feed.runs (
  id uuid primary key,
  stream_id text not null,
  producer_id text not null,
  begin_idempotency_key text not null,
  begin_payload_hash text not null,
  status text not null check (status in ('running','completed','partial','failed','cancelled')),
  envelope jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  actual_scope jsonb,
  error_summary text,
  complete_idempotency_key text,
  complete_payload_hash text,
  created_at timestamptz not null default now(),
  unique (producer_id, stream_id, begin_idempotency_key),
  check (completed_at is null or completed_at >= started_at),
  check (
    (status = 'running'
      and completed_at is null
      and actual_scope is null
      and complete_idempotency_key is null
      and complete_payload_hash is null)
    or
    (status <> 'running'
      and completed_at is not null
      and actual_scope is not null
      and complete_idempotency_key is not null
      and complete_payload_hash is not null)
  )
);

create table if not exists agent_feed.batches (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id text not null,
  idempotency_key text not null,
  sequence_number integer not null check (sequence_number >= 1),
  payload_hash text not null,
  submitted_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  accepted_at timestamptz not null default now(),
  unique (run_id, batch_id),
  unique (run_id, idempotency_key),
  unique (run_id, sequence_number)
);

create table if not exists agent_feed.findings (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id uuid not null references agent_feed.batches(id) on delete restrict,
  finding_key text not null,
  finding_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, finding_key)
);

create table if not exists agent_feed.submitted_evidence (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id uuid not null references agent_feed.batches(id) on delete restrict,
  evidence_key text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, evidence_key)
);

create table if not exists agent_feed.finding_evidence (
  finding_id uuid not null references agent_feed.findings(id) on delete restrict,
  evidence_id uuid not null references agent_feed.submitted_evidence(id) on delete restrict,
  primary key (finding_id, evidence_id)
);

-- Reserved for the later durable-delivery milestone. Milestone 1 does not
-- write or deliver outbox rows.
create table if not exists agent_feed.outbox_events (
  id uuid primary key,
  event_type text not null,
  stream_id text not null,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  finding_id uuid references agent_feed.findings(id) on delete restrict,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create table if not exists agent_feed.stream_expectations (
  stream_id text primary key,
  expected_cadence_seconds integer not null check (expected_cadence_seconds >= 3600),
  grace_seconds integer not null default 0 check (grace_seconds >= 0),
  enabled boolean not null default true,
  expected_scope jsonb not null default '{}'::jsonb,
  owner text not null,
  notes text not null default '',
  last_terminal_run_at timestamptz,
  last_terminal_status text check (last_terminal_status in ('completed','partial','failed','cancelled')),
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_feed.stream_liveness_incidents (
  id uuid primary key,
  stream_id text not null references agent_feed.stream_expectations(stream_id) on delete restrict,
  incident_type text not null check (incident_type in ('missed_run','repeated_failure','scope_degradation')),
  status text not null check (status in ('open','acknowledged','resolved')),
  detected_at timestamptz not null,
  expected_by timestamptz,
  resolved_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  check (resolved_at is null or resolved_at >= detected_at)
);

create unique index if not exists stream_liveness_one_open_incident_idx
  on agent_feed.stream_liveness_incidents (stream_id, incident_type)
  where status in ('open','acknowledged');

create index if not exists runs_stream_started_idx
  on agent_feed.runs (stream_id, started_at desc);
create index if not exists runs_status_idx
  on agent_feed.runs (status);
create index if not exists findings_run_idx
  on agent_feed.findings (run_id);
create index if not exists submitted_evidence_run_idx
  on agent_feed.submitted_evidence (run_id);

create or replace function agent_feed.protect_terminal_run()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'agent_feed runs are append-only and cannot be deleted';
  end if;
  if old.status <> 'running' then
    raise exception 'terminal Agent Feed run % is immutable', old.id;
  end if;
  if new.id <> old.id
     or new.stream_id <> old.stream_id
     or new.producer_id <> old.producer_id
     or new.begin_idempotency_key <> old.begin_idempotency_key
     or new.begin_payload_hash <> old.begin_payload_hash
     or new.started_at <> old.started_at then
    raise exception 'run identity fields are immutable';
  end if;
  if new.status = 'running' then
    raise exception 'running runs are immutable except for terminal completion';
  end if;
  if new.completed_at is null or new.completed_at < old.started_at then
    raise exception 'terminal run requires a valid completed_at';
  end if;
  if new.actual_scope is null
     or new.complete_idempotency_key is null
     or new.complete_payload_hash is null then
    raise exception 'terminal run requires completion payload fields';
  end if;
  return new;
end
$$;

drop trigger if exists runs_protect_terminal on agent_feed.runs;
create trigger runs_protect_terminal
before update or delete on agent_feed.runs
for each row execute function agent_feed.protect_terminal_run();

create or replace function agent_feed.protect_accepted_record()
returns trigger language plpgsql as $$
begin
  raise exception 'accepted Agent Feed protocol records are immutable';
end
$$;

drop trigger if exists batches_append_only on agent_feed.batches;
create trigger batches_append_only
before update or delete on agent_feed.batches
for each row execute function agent_feed.protect_accepted_record();

drop trigger if exists findings_append_only on agent_feed.findings;
create trigger findings_append_only
before update or delete on agent_feed.findings
for each row execute function agent_feed.protect_accepted_record();

drop trigger if exists submitted_evidence_append_only on agent_feed.submitted_evidence;
create trigger submitted_evidence_append_only
before update or delete on agent_feed.submitted_evidence
for each row execute function agent_feed.protect_accepted_record();

drop trigger if exists finding_evidence_append_only on agent_feed.finding_evidence;
create trigger finding_evidence_append_only
before update or delete on agent_feed.finding_evidence
for each row execute function agent_feed.protect_accepted_record();

create or replace function agent_feed.record_terminal_run_liveness()
returns trigger language plpgsql as $$
begin
  if new.status <> 'running' and old.status = 'running' then
    update agent_feed.stream_expectations
       set last_terminal_run_at = new.completed_at,
           last_terminal_status = new.status,
           next_due_at = new.completed_at + make_interval(secs => expected_cadence_seconds + grace_seconds),
           updated_at = now()
     where stream_id = new.stream_id;
  end if;
  return new;
end
$$;

drop trigger if exists runs_update_liveness on agent_feed.runs;
create trigger runs_update_liveness
after update on agent_feed.runs
for each row execute function agent_feed.record_terminal_run_liveness();

create or replace function agent_feed.sweep_overdue_streams(p_now timestamptz default now())
returns table(stream_id text, liveness_status text, expected_by timestamptz)
language plpgsql as $$
begin
  insert into agent_feed.stream_liveness_incidents (
    id, stream_id, incident_type, status, detected_at, expected_by, details
  )
  select gen_random_uuid(), se.stream_id, 'missed_run', 'open', p_now, se.next_due_at,
         jsonb_build_object(
           'last_terminal_run_at', se.last_terminal_run_at,
           'last_terminal_status', se.last_terminal_status
         )
    from agent_feed.stream_expectations se
   where se.enabled
     and (se.next_due_at is null or p_now > se.next_due_at)
     and not exists (
       select 1 from agent_feed.stream_liveness_incidents i
        where i.stream_id = se.stream_id
          and i.incident_type = 'missed_run'
          and i.status in ('open','acknowledged')
     );

  update agent_feed.stream_liveness_incidents i
     set status = 'resolved', resolved_at = p_now
    from agent_feed.stream_expectations se
   where i.stream_id = se.stream_id
     and i.incident_type = 'missed_run'
     and i.status in ('open','acknowledged')
     and se.next_due_at is not null
     and p_now <= se.next_due_at;

  return query
  select se.stream_id,
         case
           when not se.enabled then 'disabled'
           when se.last_terminal_run_at is null then 'never_seen'
           when se.next_due_at is not null and p_now > se.next_due_at then 'overdue'
           when se.last_terminal_status <> 'completed' then 'degraded'
           else 'healthy'
         end,
         se.next_due_at
    from agent_feed.stream_expectations se
   order by se.stream_id;
end
$$;
