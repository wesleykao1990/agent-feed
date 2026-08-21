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
  | "schedule_version_conflict"
  | "schedule_version_not_found"
  | "occurrence_conflict"
  | "occurrence_not_found"
  | "occurrence_already_linked"
  | "run_already_linked"
  | "no_matching_occurrence"
  | "ambiguous_occurrence"
  | "invalid_trigger_kind"
  | "trigger_context_missing"
  | "trigger_context_conflict"
  | "stream_mismatch"
  | "occurrence_validation_failed"
  | "policy_version_conflict"
  | "policy_version_not_found"
  | "assessor_registration_conflict"
  | "assessor_registration_not_found"
  | "assessor_not_independent"
  | "assessment_conflict"
  | "assessment_not_found"
  | "assessment_validation_failed"
  | "job_registry_version_conflict"
  | "job_definition_version_not_found"
  | "capability_profile_version_not_found"
  | "job_registry_preflight_failed"
  | "job_registry_validation_failed"
  | "utility_feedback_conflict"
  | "utility_feedback_not_found"
  | "utility_feedback_validation_failed"
  | "recommendation_conflict"
  | "recommendation_not_found"
  | "recommendation_approval_conflict"
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
