\set ON_ERROR_STOP on

-- Supabase deployment boundary for Agent Feed.
--
-- The protocol tables stay in the private `agent_feed` schema.  Producer and
-- delivery policy remains in the canonical application services; this
-- migration only prevents browser roles from reaching the persistence layer.
-- The service_role is used by the optional operational function and is never
-- exposed to a browser client.
begin;

revoke all on schema agent_feed from public, anon, authenticated;
grant usage on schema agent_feed to service_role;

revoke all on all tables in schema agent_feed from public, anon, authenticated;
revoke all on all sequences in schema agent_feed from public, anon, authenticated;
revoke all on all functions in schema agent_feed from public, anon, authenticated;

-- Do not grant broad table/sequence access to service_role.  The optional
-- Edge Function only calls the health RPC; the canonical API uses its own
-- dedicated server-side database role/owner connection for persistence.

-- RLS is defense in depth for a future authenticated SQL consumer.  The
-- service_role bypasses RLS, while browser roles have no schema usage at all.
-- Do not force RLS: the canonical API may use the Supabase project owner
-- connection, and that trusted server-side role must retain its owner bypass.
do $$
declare
  table_name text;
begin
  for table_name in
    select tablename
      from pg_catalog.pg_tables
     where schemaname = 'agent_feed'
  loop
    execute format('alter table agent_feed.%I enable row level security', table_name);
  end loop;
end
$$;

-- A non-sensitive readiness RPC lets an operator prove that the migrations
-- applied without exposing rows, queue state, signing keys, or credentials.
create or replace function agent_feed.health()
returns jsonb
language sql
security definer
set search_path = pg_catalog, agent_feed
as $$
  select jsonb_build_object(
    'ok', true,
    'schema', 'agent_feed',
    'protocol_version', '0.1',
    'migration_count', (select count(*) from agent_feed.schema_migrations),
    'realtime_required', false
  )
$$;

revoke execute on function agent_feed.health() from public, anon, authenticated;
grant execute on function agent_feed.health() to service_role;

-- Keep future objects private by default when migrations run as the project
-- owner.  A later migration must explicitly grant a capability to a role.
alter default privileges in schema agent_feed
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema agent_feed
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema agent_feed
  revoke all on functions from public, anon, authenticated;

commit;
