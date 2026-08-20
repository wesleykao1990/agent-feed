# `@agent-feed/job-registry-core`

Pure Milestone 9 contracts for immutable logical job definitions, provider
capability profiles, deployment bindings, and activation preflight.

The job identity is separate from deployment topology. Moving a job between
providers creates a new immutable binding version, not a new logical job.
Definitions store an instruction digest and optional controlled reference,
never prompt bytes or credentials. Active autonomous bindings fail closed
without an owner, validation policy, declared budget, off-switch reference,
independently passed shadow evidence, and compatible pinned capability
profiles.

This package does not schedule, execute, activate, or optimize jobs and does
not change Agent Feed protocol `0.1`.
