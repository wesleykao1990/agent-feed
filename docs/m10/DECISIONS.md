# Milestone 10 decisions

| ID | Decision | Reason |
|---|---|---|
| M10-D001 | Freeze a payload-free aggregate contract before PostgreSQL, dashboard, alert, and hosting adapters. | Every operational consumer must share one failure/state vocabulary. |
| M10-D002 | Keep tenant scope mandatory but prohibit tenant IDs from metrics labels. | Queries require scope; exported aggregates must avoid unbounded or identifying label cardinality. |
| M10-D003 | Preserve five independent failure layers. | Provider, gateway, execution, validation, and delivery incidents require different operators and recovery paths. |
| M10-D004 | Keep the M6 embedded OAuth provider explicitly non-production. | Durable multi-instance identity and revocation require an external OIDC boundary or persistent authorization server. |
