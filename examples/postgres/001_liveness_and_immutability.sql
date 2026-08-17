\set ON_ERROR_STOP on
begin;

insert into agent_feed.stream_expectations (
  stream_id, expected_cadence_seconds, grace_seconds, enabled, owner
) values ('rewards.daily', 3600, 60, true, 'db-test');

insert into agent_feed.runs (
  id, stream_id, producer_id, begin_idempotency_key, status, envelope, started_at, completed_at
) values (
  '00000000-0000-0000-0000-000000000101', 'rewards.daily', 'producer-test', 'begin-1',
  'running', '{}'::jsonb, '2026-08-17T00:00:00Z', null
);

update agent_feed.runs
   set status='completed', completed_at='2026-08-17T00:01:00Z'
 where id='00000000-0000-0000-0000-000000000101';

-- A completed zero-finding run is present and advances expected liveness.
do $$
declare due timestamptz;
begin
  select next_due_at into due from agent_feed.stream_expectations where stream_id='rewards.daily';
  if due is null then raise exception 'terminal run did not update liveness'; end if;
end $$;

-- Terminal state cannot be changed.
do $$
begin
  begin
    update agent_feed.runs set status='failed'
     where id='00000000-0000-0000-0000-000000000101';
    raise exception 'expected immutable terminal run';
  exception when raise_exception then
    if sqlerrm = 'expected immutable terminal run' then raise; end if;
  end;
end $$;

-- An owed run that never arrives is explicitly overdue.
select * from agent_feed.sweep_overdue_streams('2026-08-17T02:00:00Z');
do $$
begin
  if not exists (
    select 1 from agent_feed.stream_liveness_incidents
     where stream_id='rewards.daily' and incident_type='missed_run' and status='open'
  ) then raise exception 'missing overdue-run incident'; end if;
end $$;

rollback;
