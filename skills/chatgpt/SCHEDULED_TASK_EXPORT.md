# Capability-gated ChatGPT Scheduled Task export

ChatGPT web Scheduled Tasks can use installed plugins and connected MCP tools.
This procedure still does not assume that an arbitrary scheduled chat has
Agent Feed access: the task must inspect the capabilities of its actual runtime
on every deployment and use the manual bundle path when the full lifecycle is
not callable.

## Gate direct ingestion

Treat direct ingestion as available only if the runtime can demonstrate one of
these paths before the run starts:

1. all three exact Agent Feed operations, `begin_run`, `submit_batch`, and
   `complete_run`, are present and callable; or
2. a documented REST producer adapter has supplied its base URL, a scoped
   bearer credential, and network access to the documented endpoints. The
   repository's reference routes are `POST /v1/runs:begin`,
   `POST /v1/runs/{run_id}/batches`, and `POST /v1/runs/{run_id}:complete`.

The presence of a Scheduled Task, an installed plugin without the Agent Feed
connection, a generic HTTP concept, or a URL in a prompt is not a capability.
If the check cannot prove the complete lifecycle, choose manual export. Never
emit a claim that a webhook or MCP call happened without an observed receipt.
Never fabricate an unavailable operation, endpoint, header, or response field.

The decision is deliberately binary:

```text
direct_ingestion =
  (begin_run && submit_batch && complete_run are all callable)
  OR (documented REST base URL && scoped credential && network path)

if direct_ingestion is false: export run-bundle JSON for local-file import
```

Do not treat one callable operation as enough to select the direct path. A
run that loses this capability after `begin_run` follows the failure-closure
and recovery instructions below.

## Manual/local-file path

When direct ingestion is unavailable:

1. Run the research using the expected scope recorded in `begin`.
2. Build one JSON object with exactly the top-level keys
   `protocol_version`, `run_id`, `begin`, `batches`, and `complete`.
3. Use only the fields in the published `begin-run`, `submit-batch`, and
   `complete-run` contracts. Keep the top-level `run_id`, every batch's
   `run_id`, and `complete.run_id` equal, preserve batch order and increasing
   sequence numbers, and make finding evidence references resolve within the
   bundle.
4. Use `completed` for a genuinely completed check, including completed zero
   findings; use `partial` or `failed` when the expected scope was not
   completed. Put safe failure details in `complete.errors` with only `code`,
   `message`, `source_id`, and `retryable`.
5. Validate the complete JSON document against `run-bundle.schema.json` before
   handing it to the local-file adapter. Return the JSON artifact without
   surrounding prose when it is intended for import.

The local-file adapter validates the whole bundle before any lifecycle call,
then invokes `beginRunWithWireId`, each batch in array order, and
`completeRun`. Its durable service owns idempotency; replay an uncertain
operation with the original identical payload and key.

## Copyable wire-shape template

Replace every sample value with observed values and validate the result. This
shape is intentionally a zero-finding template; add a valid batch only when
there is at least one finding or evidence item in it. Do not add a
capabilities, webhook, receipt, or export-status field to the bundle.

```json
{
  "protocol_version": "0.1",
  "run_id": "run_replace_with_stable_id",
  "begin": {
    "protocol_version": "0.1",
    "idempotency_key": "begin_replace_with_stable_key",
    "stream_id": "replace.with.authorized.stream",
    "producer": {
      "producer_id": "replace-with-authorized-producer",
      "type": "chatgpt",
      "name": "ChatGPT Scheduled Task",
      "version": null
    },
    "task": {
      "task_type": "scheduled_monitor",
      "definition_id": "replace-with-task-definition",
      "definition_version": "0.1"
    },
    "expected_scope": {
      "source_ids": ["replace-with-source-id"],
      "subjects": ["replace-with-subject"],
      "queries": ["replace-with-query"],
      "metadata": {}
    },
    "started_at": "2026-08-18T00:00:00.000Z",
    "parent_run_id": null,
    "metadata": {}
  },
  "batches": [],
  "complete": {
    "protocol_version": "0.1",
    "run_id": "run_replace_with_stable_id",
    "idempotency_key": "complete_replace_with_stable_key",
    "status": "completed",
    "completed_at": "2026-08-18T00:01:00.000Z",
    "actual_scope": {
      "source_ids": ["replace-with-source-id"],
      "subjects": ["replace-with-subject"],
      "queries": ["replace-with-query"],
      "metadata": {}
    },
    "stats": {
      "sources_attempted": 1,
      "sources_succeeded": 1,
      "findings_submitted": 0,
      "evidence_submitted": 0,
      "batches_submitted": 0
    },
    "errors": [],
    "metadata": {}
  }
}
```

The template's placeholder strings are not a ready-to-import fixture. Use
the protocol schemas and the validated fixtures in `examples/m3/` before
exporting.
