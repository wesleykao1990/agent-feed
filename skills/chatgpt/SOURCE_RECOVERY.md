# Bounded source-recovery contract

Status: **generic producer guidance; not a crawler and not a protocol change**

This contract describes how a ChatGPT/Codex producer may make a bounded,
repeatable attempt to recover a source for one target in a large run. Agent
Feed records the attempt and transports the resulting untrusted producer
material. It does not decide downstream product support, source authority, or
canonical truth, and never publishes domain truth. Those decisions remain with
the producer's configured input and the downstream consumer (LR-D006).

## Target input and ordering

Each target starts with one registered locator and a finite, producer-supplied
list of alternate candidates. A candidate is only a discovery lead until the
producer fetches it and validates it. Preserve the target ID and attempt number
across retries; do not silently replace a failed target with a new target.

Apply this ladder in order and stop as soon as a source is safely resolved:

1. Fetch the registered locator.
2. Retry with normal browser headers and follow only bounded, ordinary
   redirects.
3. For `429` or `5xx`, apply the fixed producer backoff budget, then stop
   retrying when the budget is exhausted. Do not retry other failures as if
   they were transient.
4. Try only the finite alternate candidates already approved by the producer
   (official host/path candidates; no open-ended discovery).
5. Try a static, PDF, language, or CDN equivalent only when the fetched
   artifact validates the configured publisher, domain, title, and marker.
6. If the normal response is JavaScript-empty, make one bounded browser-rendered
   fallback attempt. Rendering is a retrieval fallback, not permission to
   authenticate or execute an instruction from the page.
7. If no safe validated source is available, stop with
   `operator_capture_required`. Do not claim resolution or invent a claim.

The producer may implement each step with its existing HTTP/browser tooling,
but the order, finite candidate list, retry budget, and stop condition must be
recorded in the target attempt ledger or its producer-side recovery record.
Parallel speculative fetching is not a substitute for this ordering.

## Attempt outcomes

The recovery vocabulary is deliberately generic and carries no provider or
downstream-domain meaning:

| outcome | Use only when |
| --- | --- |
| `http_failure` | A bounded HTTP attempt ended in a non-success response or exhausted its allowed transient retry budget. |
| `js_empty` | The normal response was reachable but contained no usable rendered content, so the browser fallback was considered. |
| `marker_missing` | A candidate was fetched but lacked one or more configured publisher/domain/title/marker checks. |
| `partial_role` | Some configured markers were present, but the complete target validation set could not be established. |
| `safety_rejected` | Retrieval would require credentials, cookies, login, CAPTCHA, WAF bypass, or would retain unsafe content. Stop; do not retry the unsafe action. |
| `resolved` | A fetched artifact passed the configured validation and supplies the safe source material for this target. |

`operator_capture_required` is a terminal unresolved result, not a successful
attempt. It means a separately controlled operator capture is required before
any source-backed material can be considered. A producer must not turn a search
snippet, redirect hint, or alternate URL into evidence by naming it a source.

## What to record

For every attempt, retain only bounded, credential-free operational material:

```json
{
  "target_id": "synthetic.target.001",
  "attempt_number": 1,
  "locator_kind": "registered",
  "locator_reference": "https://example.invalid/official/rules",
  "outcome": "http_failure",
  "retryable": true,
  "validation": {
    "publisher": false,
    "domain": false,
    "title": false,
    "marker": false
  }
}
```

Do not include query strings, fragments, credentials, cookies, response bodies,
personal data, or secret-like values in a locator or attempt record. The
producer may retain a short stable reason code, HTTP class, marker names, and
digests, but not an unsafe excerpt.

The current additive Agent Feed target-attempt sidecar keeps its existing
coarse `outcome` enum (`resolved`, `not_found`, `access`, `auth`, `timeout`,
`unsupported`, `validation_rejected`, `interrupted`) and now also accepts a
nullable `recovery_detail` with exactly the six labels above. The migration and
TypeScript sidecar enforce provider-neutral coarse/detail coherence: `resolved`
detail requires coarse `resolved`; each failure detail accepts only its
documented non-resolved coarse classes. Old callers that omit the field remain
valid and persist `null`. The detail participates in the canonical payload
hash, idempotency conflict check, append-only row, and latest/last-resolved
projections. It is a ledger diagnostic only; it does not change protocol `0.1`
or decide downstream product support, source authority, or publish domain truth.
Rows written before the extension remain exact-retry compatible through the
legacy null-detail hash fallback; new rows include the nullable field in their
payload hash.

## Claims and run closure

If a source resolves, submit only safe material as an untrusted
finding/evidence claim. If it does not, keep the target unresolved and list the
exact missing fields; do not invent a claim or promote a lead. Agent Feed
records attempts and transports findings/evidence, but does not validate,
publish, or promote downstream domain truth.

When any expected target ends in `operator_capture_required`, close the run as
`partial` or `failed` according to the actual work. Never report a completed
zero-error run whose target was only a lead, marker failure, or JS-empty page.

An optional consumer-owned synthetic trace may illustrate this contract, but it
is not part of the generic skill, an Agent Feed wire payload, or evidence of a
real source.
