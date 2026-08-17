# Agent Feed semantic invariants

JSON Schema defines portable shape. The implementation must also enforce:

- `running` runs have no completion time or actual scope; terminal runs have both;
- completion time is not earlier than start time;
- `sources_succeeded <= sources_attempted`;
- completion finding/evidence/batch counts equal accepted rows;
- batch sequence numbers and finding/evidence IDs are unique within a run;
- every finding evidence reference resolves within the run or is explicitly rejected;
- a portable run bundle has one run ID shared by all batches and completion;
- terminal run state is immutable;
- repeating an idempotency key with a different payload is a conflict, not a retry;
- a producer authority classification is a claim, not a verified fact;
- secret-bearing evidence is quarantined/rejected according to policy.

## Producer liveness

A registered stream with an expected cadence owes terminal runs. A missing run is not equivalent to a completed zero-finding run.

- consumer-owned cadence and grace windows are authoritative for health evaluation;
- a stream with no terminal run inside its window is `overdue` and raises a missed-run incident;
- terminal runs include `completed`, `partial`, `failed`, and `cancelled` because all prove the producer executed;
- only `completed` with zero findings means “checked successfully; no changes found”;
- recovered streams resolve, but do not delete, their missed-run incidents;
- liveness state must be computable without trusting producer-supplied schedule metadata.
