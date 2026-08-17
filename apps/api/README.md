# REST API

Status: **M1 producer reference plus M2 consumer API design; no executable API
handlers are present in this app yet.**

The current runnable REST/reference path is the prototype under
`prototype/src/server.ts`. This directory is not evidence that the following
routes are live.

M1 producer reference endpoints:

```text
POST /v1/runs:begin
POST /v1/runs/{run_id}/batches
POST /v1/runs/{run_id}:complete
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/findings
```

Write endpoints require scoped producer credentials in the implemented
prototype path. M2 consumer operations are specified in
`docs/operations/delivery-api.md` and are not implemented here yet:

- subscription creation/update/listing;
- pull pages and scoped cursors;
- acknowledgement;
- dead-letter inspection and replay.

When handlers are added, they must call the shared delivery consumer service,
derive tenant/consumer identity from authenticated credentials, and never query
another consumer's feed. Do not add direct SQL or delivery-worker behavior to
this README-only boundary.
