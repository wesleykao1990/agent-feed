import type {
  AuthorizationGrant,
  OAuthStateStore,
  StoredClient,
  TokenGrant,
} from "./auth.ts";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface OAuthSqlPool {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

interface PayloadRow<T> {
  payload: T;
}

/**
 * Creates the small sidecar tables used by the remote MCP OAuth provider.
 * This is intentionally idempotent so serverless cold starts can race safely.
 */
export async function ensureMcpOAuthState(pool: OAuthSqlPool): Promise<void> {
  await pool.query(`
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
  `);
}

export class PostgresOAuthStateStore implements OAuthStateStore {
  readonly #pool: OAuthSqlPool;

  constructor(pool: OAuthSqlPool) {
    this.#pool = pool;
  }

  async countClients(): Promise<number> {
    const result = await this.#pool.query<{ count: string }>("select count(*)::text as count from agent_feed.mcp_oauth_clients");
    return Number(result.rows[0]?.count ?? "0");
  }

  async getClient(clientId: string): Promise<StoredClient | undefined> {
    const result = await this.#pool.query<PayloadRow<StoredClient>>(
      "select payload from agent_feed.mcp_oauth_clients where client_id = $1",
      [clientId],
    );
    return result.rows[0]?.payload;
  }

  async putClient(client: StoredClient): Promise<void> {
    await this.#pool.query(
      `insert into agent_feed.mcp_oauth_clients(client_id, payload)
       values ($1, $2::jsonb)
       on conflict (client_id) do update set payload = excluded.payload`,
      [client.client_id, JSON.stringify(client)],
    );
  }

  async putCode(tokenHash: string, grant: AuthorizationGrant): Promise<void> {
    await this.#putGrant("mcp_oauth_codes", tokenHash, grant);
  }

  async takeCode(tokenHash: string): Promise<AuthorizationGrant | undefined> {
    return this.#takeGrant<AuthorizationGrant>("mcp_oauth_codes", tokenHash);
  }

  async putAccessToken(tokenHash: string, grant: TokenGrant): Promise<void> {
    await this.#putGrant("mcp_oauth_access_tokens", tokenHash, grant);
  }

  async getAccessToken(tokenHash: string): Promise<TokenGrant | undefined> {
    const result = await this.#pool.query<PayloadRow<TokenGrant>>(
      `select payload from agent_feed.mcp_oauth_access_tokens
       where token_hash = $1 and expires_at > now()`,
      [tokenHash],
    );
    return result.rows[0]?.payload;
  }

  async putRefreshToken(tokenHash: string, grant: TokenGrant): Promise<void> {
    await this.#putGrant("mcp_oauth_refresh_tokens", tokenHash, grant);
  }

  async takeRefreshToken(tokenHash: string): Promise<TokenGrant | undefined> {
    return this.#takeGrant<TokenGrant>("mcp_oauth_refresh_tokens", tokenHash);
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.#pool.query("delete from agent_feed.mcp_oauth_access_tokens where token_hash = $1", [tokenHash]);
    await this.#pool.query("delete from agent_feed.mcp_oauth_refresh_tokens where token_hash = $1", [tokenHash]);
  }

  async #putGrant(table: string, tokenHash: string, grant: AuthorizationGrant | TokenGrant): Promise<void> {
    await this.#pool.query(
      `insert into agent_feed.${table}(token_hash, payload, expires_at)
       values ($1, $2::jsonb, to_timestamp($3))
       on conflict (token_hash) do update
       set payload = excluded.payload, expires_at = excluded.expires_at`,
      [tokenHash, JSON.stringify(grant), grant.expires_at],
    );
  }

  async #takeGrant<T>(table: string, tokenHash: string): Promise<T | undefined> {
    const result = await this.#pool.query<PayloadRow<T>>(
      `delete from agent_feed.${table}
       where token_hash = $1 and expires_at > now()
       returning payload`,
      [tokenHash],
    );
    return result.rows[0]?.payload;
  }
}
