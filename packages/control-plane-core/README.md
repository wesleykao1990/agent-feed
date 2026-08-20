# `@agent-feed/control-plane-core`

Pure Milestone 10 contract for a tenant-scoped, payload-free operational
snapshot spanning jobs, occurrences, runs, assessments, and deliveries.

It distinguishes provider, gateway, execution, validation, and delivery
failures, reconciles every state count, preserves completed-zero versus absent
occurrences, requires an explicit observation window, and derives bounded
health/freshness. It accepts no findings,
evidence, artifacts, prompts, URLs, credentials, or raw error details.

The PostgreSQL adapter, dashboard, alert exporter, and identity layer are
separate consumers. This package performs no I/O and makes no production
hosting or identity claim.
