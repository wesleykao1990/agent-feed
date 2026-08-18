# Observability bugs and follow-up

| ID | Finding | Disposition |
| --- | --- | --- |
| M5O-001 | The existing delivery-core `MetricsSink` accepts arbitrary names and labels, so it is not by itself a production exporter boundary. | This package provides a separate allowlisted snapshot/exporter boundary. A worker composition root still needs to adapt its events into the aggregate input. |
| M5O-002 | A database scrape can fail after the previous successful sample has been served. | The HTTP adapter must cache and serve the last successful snapshot with a failure health signal; this library intentionally does not own cache state. |
| M5O-003 | SQL metadata byte estimates differ across PostgreSQL and SQLite. | The persistence adapter supplies a bounded estimate; the common metric contract does not assume one database-specific function. |
| M5O-004 | Cumulative cost and egress counters can reset during deployment. | The deployment adapter must document reset behavior and alert on counter resets; the metric library preserves the sample it receives. |
| M5O-005 | `toPrometheus` trusted any object typed as `MetricSnapshot`, allowing forged names, HELP text, labels, or non-finite values to inject or corrupt exposition. | Resolved: renderer validation now requires the exact collector schema, canonical timestamp, fixed label vocabulary, and finite non-negative values; adversarial name/help/label/value tests fail closed. |
