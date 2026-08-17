create extension if not exists pgcrypto;

-- Reference only; implementation must add deployment-specific roles and policies.
create schema if not exists agent_feed;

create table agent_feed.runs (
  id uuid primary key,
  stream_id text not null,
  producer_id text not null,
  begin_idempotency_key text not null,
  status text not null check (status in ('running','completed','partial','failed','cancelled')),
  envelope jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  unique (producer_id, stream_id, begin_idempotency_key)
);

create table agent_feed.batches (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id text not null,
  idempotency_key text not null,
  sequence_number integer not null check (sequence_number >= 1),
  payload_hash text not null,
  accepted_at timestamptz not null default now(),
  unique (run_id, batch_id),
  unique (run_id, idempotency_key)
);

create table agent_feed.findings (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id uuid not null references agent_feed.batches(id) on delete restrict,
  finding_key text not null,
  finding_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, finding_key)
);

create table agent_feed.submitted_evidence (
  id uuid primary key,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  batch_id uuid not null references agent_feed.batches(id) on delete restrict,
  evidence_key text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, evidence_key)
);

create table agent_feed.finding_evidence (
  finding_id uuid not null references agent_feed.findings(id) on delete restrict,
  evidence_id uuid not null references agent_feed.submitted_evidence(id) on delete restrict,
  primary key (finding_id, evidence_id)
);

create table agent_feed.outbox_events (
  id uuid primary key,
  event_type text not null,
  stream_id text not null,
  run_id uuid not null references agent_feed.runs(id) on delete restrict,
  finding_id uuid references agent_feed.findings(id) on delete restrict,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

-- v0.1.1 hardening: expected-run liveness and immutable accepted protocol records.
create table agent_feed.stream_expectations (
  stream_id text primary key,
  expected_cadence_seconds integer not null check (expected_cadence_seconds >= 3600),
  grace_seconds integer not null default 0 check (grace_seconds >= 0),
  enabled boolean not null default true,
  expected_scope jsonb not null default '{}'::jsonb,
  owner text not null,
  last_terminal_run_at timestamptz,
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_feed.stream_liveness_incidents (
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

create unique index stream_liveness_one_open_incident_idx
  on agent_feed.stream_liveness_incidents (stream_id, incident_type)
  where status in ('open','acknowledged');

create or replace function agent_feed.protect_terminal_run()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'agent_feed runs are append-only and cannot be deleted';
  end if;
  if old.status <> 'running' then
    raise exception 'terminal Agent Feed run % is immutable', old.id;
  end if;
  if new.status = 'running' then
    if new.completed_at is not null then
      raise exception 'running run cannot have completed_at';
    end if;
    return new;
  end if;
  if new.completed_at is null or new.completed_at < old.started_at then
    raise exception 'terminal run requires a valid completed_at';
  end if;
  return new;
end
$$;

create trigger runs_protect_terminal
before update or delete on agent_feed.runs
for each row execute function agent_feed.protect_terminal_run();

create or replace function agent_feed.protect_accepted_record()
returns trigger language plpgsql as $$
begin
  raise exception 'accepted Agent Feed protocol records are immutable';
end
$$;

create trigger batches_append_only
before update or delete on agent_feed.batches
for each row execute function agent_feed.protect_accepted_record();
create trigger findings_append_only
before update or delete on agent_feed.findings
for each row execute function agent_feed.protect_accepted_record();
create trigger submitted_evidence_append_only
before update or delete on agent_feed.submitted_evidence
for each row execute function agent_feed.protect_accepted_record();

create or replace function agent_feed.record_terminal_run_liveness()
returns trigger language plpgsql as $$
begin
  if new.status <> 'running' and (old.status = 'running') then
    update agent_feed.stream_expectations
       set last_terminal_run_at = greatest(coalesce(last_terminal_run_at, new.completed_at), new.completed_at),
           next_due_at = new.completed_at + make_interval(secs => expected_cadence_seconds + grace_seconds),
           updated_at = now()
     where stream_id = new.stream_id;
  end if;
  return new;
end
$$;

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
         jsonb_build_object('last_terminal_run_at', se.last_terminal_run_at)
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
           else 'healthy'
         end,
         se.next_due_at
    from agent_feed.stream_expectations se;
end
$$;
