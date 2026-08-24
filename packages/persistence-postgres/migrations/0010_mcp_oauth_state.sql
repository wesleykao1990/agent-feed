create table if not exists agent_feed.mcp_oauth_clients (
  client_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_feed.mcp_oauth_codes (
  token_hash text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_feed.mcp_oauth_access_tokens (
  token_hash text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_feed.mcp_oauth_refresh_tokens (
  token_hash text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_codes_expires_at_idx
  on agent_feed.mcp_oauth_codes (expires_at);
create index if not exists mcp_oauth_access_tokens_expires_at_idx
  on agent_feed.mcp_oauth_access_tokens (expires_at);
create index if not exists mcp_oauth_refresh_tokens_expires_at_idx
  on agent_feed.mcp_oauth_refresh_tokens (expires_at);

insert into agent_feed.schema_migrations(version)
values ('0010_mcp_oauth_state')
on conflict (version) do nothing;
