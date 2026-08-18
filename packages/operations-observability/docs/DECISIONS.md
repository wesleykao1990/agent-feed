# Observability decisions

## M5O-D001 — Aggregate before the exporter boundary

The persistence adapter must aggregate by tenant, consumer, subscription,
producer, and event internally, then discard those dimensions before calling
`collectMetrics`. The package receives only bounded counts and fixed reason or
state enums. This makes source privacy and series cardinality properties
structural instead of relying on every deployment to remember a label policy.

## M5O-D002 — Keep Realtime out of the source of truth

Backlog, lease, attempt, and liveness values must be read from durable
PostgreSQL/SQLite state. Realtime may be used later to refresh a dashboard, but
it may not create, acknowledge, or replace a metric sample.

## M5O-D003 — Cost metrics are estimates, not billing records

The exported USD value is an operational estimate based on durable egress and
deployment-specific rates. It is deliberately named `estimated_cost` and must
not be used as a financial ledger or invoice source.

## M5O-D004 — Export a fixed family set

The collector always emits the same 19 families, including zero-valued cost,
retention, and liveness-state series. Stable output makes scrape and dashboard
behavior deterministic and avoids series churn when an incident category has
no current rows.

## M5O-D005 — Revalidate snapshots at the renderer boundary

`MetricSnapshot` is a compile-time interface, not a runtime authority. The
Prometheus renderer validates the exact canonical family schema and label
sequence before assembling any output. This protects deployments that cache,
deserialize, or pass snapshots across a process boundary without duplicating
the collector's trust assumptions.
