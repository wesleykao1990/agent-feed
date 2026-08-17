# REST API

Reference endpoints:

```text
POST /v1/runs:begin
POST /v1/runs/{run_id}/batches
POST /v1/runs/{run_id}:complete
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/findings
```

Write endpoints require scoped producer credentials. Consumer delivery uses signed webhook events or pull-based cursors; it never exposes another consumer's feed.
