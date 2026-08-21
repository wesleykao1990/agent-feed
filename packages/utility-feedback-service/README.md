# Utility Feedback Service

This package is the trusted consumer application boundary for Milestone 12.
It accepts authenticated tenant/consumer or approver context separately from
request bodies, normalizes records with `@agent-feed/utility-feedback-core`, and
persists them through an injected repository.

It cannot modify findings, evidence, artifacts, prompts, schedules, or provider
configuration. Recommendations remain digest-only and pending; an approval is a
separate append-only event, not an execution command.
