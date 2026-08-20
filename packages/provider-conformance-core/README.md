# `@agent-feed/provider-conformance-core`

Pure Milestone 11 contract for comparing occurrence, execution, independent
assessment, delivery, and telemetry proof across provider topologies.

Receipts pin the same logical job, definition hash, policy version, deployment
binding hash, and capability-profile hashes. Provider-specific invocation IDs
are represented only by SHA-256 digests. Raw prompts, outputs, findings,
evidence, URLs, credentials, provider responses, and free-form metadata are not
accepted.

Every standard usage metric is explicit. Unsupported telemetry is `unknown`
with a null value and unknown provenance; it is never invented as zero. A
matrix requires at least three distinct terminal topologies for one exact
logical job identity.

The first executable fixtures exercise the existing ChatGPT manual-export,
Claude hook, generic MCP, REST, and local-file routing boundaries with injected
lifecycle services. They prove adapter-shape comparability, not live provider
accounts, scheduled-task execution, durable PostgreSQL proof, or production
hosting.
