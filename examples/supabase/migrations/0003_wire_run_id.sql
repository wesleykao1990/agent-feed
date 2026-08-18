\set ON_ERROR_STOP on

-- Protocol run_id is a producer-visible string.  Keep the existing UUID
-- primary/foreign-key graph as the relational identity and add a stable wire
-- identity for API paths, envelopes, idempotent receipts, and delivery events.
-- Existing M1/M2 rows are backfilled from their internal UUID text.

alter table agent_feed.runs
  add column if not exists wire_run_id text;

update agent_feed.runs
   set wire_run_id = id::text
 where wire_run_id is null or wire_run_id = '';

-- Keep direct trusted SQL fixtures and legacy internal callers compatible: a
-- row that omits the new column gets the UUID text as its wire identity.
create or replace function agent_feed.set_run_wire_identity()
returns trigger language plpgsql as $$
begin
  if new.wire_run_id is null or new.wire_run_id = '' then
    new.wire_run_id := new.id::text;
  end if;
  return new;
end
$$;

drop trigger if exists runs_set_wire_identity on agent_feed.runs;
create trigger runs_set_wire_identity
before insert on agent_feed.runs
for each row execute function agent_feed.set_run_wire_identity();

alter table agent_feed.runs
  alter column wire_run_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'runs_wire_run_id_ck'
       and conrelid = 'agent_feed.runs'::regclass
  ) then
    alter table agent_feed.runs
      add constraint runs_wire_run_id_ck check (length(wire_run_id) between 8 and 512);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'runs_tenant_wire_run_id_key'
       and conrelid = 'agent_feed.runs'::regclass
  ) then
    alter table agent_feed.runs
      add constraint runs_tenant_wire_run_id_key unique (tenant_id, wire_run_id);
  end if;
end
$$;

create index if not exists runs_tenant_wire_run_idx
  on agent_feed.runs (tenant_id, wire_run_id);

alter table agent_feed.outbox_events
  add column if not exists wire_run_id text;

update agent_feed.outbox_events event
   set wire_run_id = run.wire_run_id
  from agent_feed.runs run
 where event.tenant_id = run.tenant_id
   and event.run_id = run.id
   and (event.wire_run_id is null or event.wire_run_id = '');

alter table agent_feed.outbox_events
  alter column wire_run_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'outbox_events_tenant_wire_run_fk'
       and conrelid = 'agent_feed.outbox_events'::regclass
  ) then
    alter table agent_feed.outbox_events
      add constraint outbox_events_tenant_wire_run_fk
      foreign key (tenant_id, wire_run_id)
      references agent_feed.runs (tenant_id, wire_run_id)
      not valid;
  end if;
end
$$;

create index if not exists outbox_events_tenant_wire_run_idx
  on agent_feed.outbox_events (tenant_id, wire_run_id);

-- The wire identity is immutable just like the internal relational identity.
create or replace function agent_feed.protect_run_wire_identity()
returns trigger language plpgsql as $$
begin
  if new.wire_run_id <> old.wire_run_id then
    raise exception 'run wire identity is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists runs_protect_wire_identity on agent_feed.runs;
create trigger runs_protect_wire_identity
before update on agent_feed.runs
for each row execute function agent_feed.protect_run_wire_identity();

-- Populate and validate the public wire identity whenever a source event is
-- inserted.  The internal UUID remains the only relational foreign key.
create or replace function agent_feed.set_outbox_event_defaults()
returns trigger
language plpgsql
as $$
declare
  run_tenant text;
  run_stream text;
  run_wire_id text;
begin
  select tenant_id, stream_id, wire_run_id
    into run_tenant, run_stream, run_wire_id
    from agent_feed.runs
   where id = new.run_id;
  if run_tenant is null then
    raise exception 'outbox event run does not exist';
  end if;
  if new.tenant_id <> run_tenant or new.stream_id <> run_stream then
    raise exception 'outbox event crosses run or tenant scope';
  end if;
  if new.wire_run_id is null or new.wire_run_id = '' then
    new.wire_run_id := run_wire_id;
  elsif new.wire_run_id <> run_wire_id then
    raise exception 'outbox event wire run identity mismatch';
  end if;

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
  new.stream_position := agent_feed.next_stream_event_position(new.tenant_id, new.stream_id);
  return new;
end
$$;

drop trigger if exists outbox_events_set_defaults on agent_feed.outbox_events;
create trigger outbox_events_set_defaults
before insert on agent_feed.outbox_events
for each row execute function agent_feed.set_outbox_event_defaults();

-- The ledger was introduced by 0002 after 0001 had already run. Record both
-- the foundation migration and this additive migration so operational checks
-- can prove the complete explicit sequence.
insert into agent_feed.schema_migrations (version)
values ('0001_agent_feed'), ('0003_wire_run_id')
on conflict (version) do nothing;
