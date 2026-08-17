export type PersistenceErrorCode =
  | "idempotency_payload_conflict"
  | "run_not_found"
  | "run_id_conflict"
  | "terminal_run_immutable"
  | "batch_not_found"
  | "batch_id_conflict"
  | "batch_sequence_not_increasing"
  | "duplicate_finding"
  | "duplicate_evidence"
  | "unresolved_evidence_ref"
  | "completion_before_start"
  | "invalid_scope_stats"
  | "completion_counts_do_not_reconcile"
  | "invalid_input"
  | "storage_error";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PersistenceErrorCode, message: string = code, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.details = details;
  }
}

export function isPersistenceError(error: unknown, code?: PersistenceErrorCode): error is PersistenceError {
  return error instanceof PersistenceError && (code === undefined || error.code === code);
}
