import type { QueryResult, QueryResultRow } from "pg";

export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface SqlClient extends SqlExecutor {
  release(error?: Error): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

export interface ControlPlaneQueryOptions {
  readonly tenantId: string;
  readonly observationWindowSeconds?: number;
  readonly freshnessWindowSeconds?: number;
  /** Strict UTC instant for deterministic tests/replays; the database clock is used when omitted. */
  readonly asOf?: string;
}

export type ControlPlanePostgresErrorCode = "invalid_input" | "storage_error";

export class ControlPlanePostgresError extends Error {
  readonly code: ControlPlanePostgresErrorCode;
  readonly cause?: unknown;

  constructor(code: ControlPlanePostgresErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ControlPlanePostgresError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
