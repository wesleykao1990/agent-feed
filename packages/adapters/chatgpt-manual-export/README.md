# ChatGPT manual-export adapter

`@agent-feed/chatgpt-manual-export-adapter` turns a monitoring-task response
into one validated protocol `0.1` run bundle. A response that is already a
bundle is validated and preserved; free-form output becomes an explicitly
untrusted observation with identity-derived run/idempotency keys. Identity
includes the response digest, stream/task/scope context, source URI, metadata,
status, and occurrence timestamp, so different occurrences cannot silently
reuse keys with a changed payload. The
JSON string can be copied to a file and imported by
`@agent-feed/local-file-adapter`.

```ts
const exporter = new ChatGPTManualExportAdapter(); // no tools: safe fallback
const { json } = await exporter.export({
  response: taskResponse,
  stream_id: "monitor.stream",
  expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
});
// write json to a local run-bundle file for manual import
```

Direct submission is opt-in only: pass `direct_ingestion_capability: true`, a
producer service, and a principal, then call `submit`. Without that explicit
capability `submit` fails closed and `export` remains the supported path; this
does not claim that ChatGPT Scheduled Tasks provide webhooks or arbitrary
outbound tools. Response bytes, excerpt length, credential-like text, and
JSON/schema shape are checked before any lifecycle call. Errors never include
the response body or mapper exception text. If direct submission fails after
begin, the local-file recovery contract closes the run or returns exact
resumable material.

For an exact retry, persist and reuse the exported bundle (preferred), or
provide the same `run_id` and `started_at`, keep mapper output deterministic,
and preserve the same stream/task/scope/metadata/source inputs. Omitting
`started_at` intentionally makes a later export a new occurrence because its
capture time changes. Idempotency keys are derived from this canonical identity;
they are not based on response text alone.
