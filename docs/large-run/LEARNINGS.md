# Large-run scaling learnings

- A one-finding end-to-end rehearsal proves trust boundaries, not throughput.
- Forty-four family-role inputs are still producer data work even if transport
  can accept them in one request.
- Body bytes become the limiting dimension before item count when evidence
  excerpts are large.
- Deterministic retries require timestamp, order, metadata, limits, and content
  to remain fixed; a checkpoint without those inputs is insufficient.
- Backpressure belongs at durable receipt boundaries. Concurrent batch
  submission would conflict with ordered sequence semantics and burst limits.
- Parent/child run sharding is additional state and should follow evidence that
  one run with bounded repeated batches cannot meet a measured workload.
- Environment bootstrap failures are not product failures, but acceptance must
  rerun the unchanged gate with declared dependencies and required localhost
  access rather than recording a skip.
- A canonical digest is not enough for byte-stable replay if the emitted JSON
  retains caller object insertion order; normalize the wire object too.
- Attempt history must remain append-only; derive current and last-resolved
  target state so a failed retry cannot erase an earlier resolution.
- Future-only subscription activation and historical recovery are separate
  operations. Historical recovery needs an exact event set, an independent
  run-set cross-check, selector replay, and one transaction—not a broad
  “deliver old events” switch.
- Temporary HTTPS endpoints can disappear between configuration and send.
  Durable retry must preserve the event while endpoint rotation remains an
  explicit subscription update.
- Trying only the first safe DNS result creates avoidable outages. Retry a
  small bounded set of already validated pinned addresses only before response
  headers; never re-resolve or turn an HTTP response into an address retry.
- End-to-end delivery tests reveal ordering/privacy defects that component
  tests miss. The Rewards subset-terminal failure was caused by redaction
  occurring before scope reconciliation, not by producer extraction or queue
  durability.
