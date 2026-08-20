# `@agent-feed/utility-feedback-core`

Pure Milestone 12 contract for consumer-owned, append-only finding and artifact
dispositions, bounded utility metrics, and approval-gated optimization
recommendations.

Consumer identity is trusted context supplied separately from the feedback
body. Feedback references immutable run/finding/assessment IDs or artifact
digests and cannot carry or rewrite finding, evidence, prompt, or schedule
content. Exact retries return the original record; key reuse with changed
content fails closed.

Metric snapshots preserve exact definition and validation-policy scope and use
integer numerator/denominator pairs rather than floating point. Recommendations
carry only a digest and controlled reference. Prompt or schedule changes remain
pending until a separately authorized approval record exists; this package does
not apply configuration changes.
