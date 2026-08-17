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

Accepted batches, findings, and evidence are append-only. Run closure and delivery state are recorded separately. Corrections create new findings or consumer-side corrections rather than overwriting history.

## Prompt injection

All source content is untrusted. Embedded instructions are preserved only as content/security flags and cannot change the producer task or consumer behavior.
