import { UTILITY_FEEDBACK_VERSION, UtilityFeedbackError, type AppendUtilityFeedbackResult, type ConsumerOwner, type UtilityFeedbackInput, type UtilityFeedbackRecord } from "./types.ts";
import { normalizeUtilityFeedback } from "./validation.ts";

export function appendUtilityFeedback(existing: readonly UtilityFeedbackRecord[], input: UtilityFeedbackInput, owner: ConsumerOwner): AppendUtilityFeedbackResult {
  const candidate = normalizeUtilityFeedback(input, owner);
  const seen = new Set<string>();
  for (const record of existing) {
    if (record.schemaVersion !== UTILITY_FEEDBACK_VERSION || !/^[a-f0-9]{64}$/u.test(record.recordHash) || !Object.isFrozen(record) || !Object.isFrozen(record.owner) || !Object.isFrozen(record.target) || !Object.isFrozen(record.scope)) {
      throw new UtilityFeedbackError(["records:normalized_immutable_record_required"]);
    }
    const identity = `${record.owner.tenantId}\u0000${record.owner.consumerId}\u0000${record.feedbackKey}`;
    if (seen.has(identity)) throw new UtilityFeedbackError(["records:duplicate_feedback_key"]);
    seen.add(identity);
  }
  const prior = existing.find((record) => record.owner.tenantId === candidate.owner.tenantId && record.owner.consumerId === candidate.owner.consumerId && record.feedbackKey === candidate.feedbackKey);
  if (prior) {
    if (prior.recordHash !== candidate.recordHash) throw new UtilityFeedbackError(["feedbackKey:idempotency_payload_conflict"]);
    return Object.freeze({ records: Object.freeze([...existing]), record: prior, appended: false });
  }
  return Object.freeze({ records: Object.freeze([...existing, candidate]), record: candidate, appended: true });
}
