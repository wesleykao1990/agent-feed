# P0 large-run scaling checkpoint

Status: **TypeScript SDK pure checkpoint green locally; production scale is not
yet claimed**

## Evidence reviewed

Rewards Optimizer `origin/main` commit `3b51de3` contains
`docs/reviews/p0-provisional-agent-feed-rehearsal-2026-08-21.md`. The rehearsal
proved one exact `merchant.7eleven / accepted_payment_methods` path:

1. validate a local protocol `0.1` run bundle;
2. map one finding into an untrusted observation;
3. retain submitted evidence as lead-only;
4. admit one under-review experimental candidate; and
5. remove it from selection after a credible correction.

It did not prove broad P0 coverage. Its own next-step record says 44 source
families require explicit producer inputs, truthful family-role coverage,
deterministic support checks, extractor authenticity, and correction
adjudication. Those remain Rewards consumer and producer responsibilities;
Agent Feed must carry their outputs without inventing them.

## Transport gap found

Protocol `0.1` already supports repeated `submit_batch` calls, durable
idempotency, exact retries, and explicit partial/terminal completion. The
TypeScript producer SDK exposed only a single-batch call, leaving every large
producer to invent its own chunking, body accounting, evidence ordering,
restart identity, and backpressure loop.

That gap is material even when 44 small findings happen to fit in one request:
real evidence excerpts can hit the 1 MiB body limit before the item limit, and
future cohorts can exceed both. Raising limits would increase memory and abuse
risk rather than solve resumability.

## Implemented boundary

`@agent-feed/sdk` now provides:

- `planLargeRunBatches`, an async generator over synchronous or asynchronous
  `LargeRunUnit` sources;
- existing 1 MiB, 100-finding, and 100-evidence deployment defaults;
- exact UTF-8 serialized body measurement;
- atomic units that are never split across batches;
- evidence-reference validation against the same or an earlier unit;
- global duplicate finding/evidence ID rejection;
- canonical content-derived batch IDs and idempotency keys; and
- `ProducerClient.submitLargeRun`, which awaits each durable batch receipt
  before requesting the next and exposes an accepted-batch checkpoint hook.

Input order, fixed `submitted_at`, metadata, limits, and content are part of
plan identity. Replaying those exact inputs produces byte-equal requests.
Changing any of them is a new plan, not a resume.

## Deliberate non-goals

- no protocol `0.1` schema change;
- no larger ingress or database limits;
- no automatic run completion;
- no domain family/role vocabulary in Agent Feed;
- no automatic crawler, scheduler, or canonical-evidence promotion;
- no claim that 250 synthetic units establish sustained production throughput;
  and
- no parent/child sharding model until a real workload proves one run with
  repeated bounded batches is insufficient.

## Next proof

The synthetic live PostgreSQL gate proves 250 findings and evidence records
across three batches plus exact terminal retry. It is durability evidence, not
a throughput benchmark. Use the authorized 44-family producer inputs when
available to run a live rehearsal through durable REST. Record total bytes, batches,
rate-limit delay, transient retries, database latency, delivery backlog,
consumer review yield, and interruption recovery. Production scale requires a
shared limiter or gateway for multiple API replicas; the built-in limiter is
process-local by design.
