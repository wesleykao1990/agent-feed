# Trust model

## Finding is not fact

Agent Feed records that a producer submitted a claim. It does not certify the truth of that claim, the authority of its source, or the consumer-domain meaning of the attributes.

Agent-provided confidence is metadata only. It cannot outrank claimed source authority or a consumer's evidence policy.

## Submitted evidence is not canonical evidence

Agent Feed may retain a URL, excerpt, locator, hash, or uploaded artifact. Each consumer decides whether to:

- reject it;
- use it only as a discovery lead;
- recapture the primary source;
- copy/promote it into its own immutable evidence store.

## Immutable core and auditable lifecycle

Accepted batches, findings, evidence, and source delivery events are
append-only. Run closure and per-consumer delivery state are recorded
separately. A retry changes only delivery-attempt state and the required
attempt value in the signed delivery body; it does not change event ID,
payload, occurred time, or payload hash. Corrections create new findings or
consumer-side corrections rather than overwriting history.

Delivery does not promote a finding or submitted evidence into verified truth.
Dead-letter replay preserves the original untrusted event and audit history;
it is not a verification or canonical-evidence operation.

## Prompt injection

All source content is untrusted. Embedded instructions are preserved only as content/security flags and cannot change the producer task or consumer behavior.
