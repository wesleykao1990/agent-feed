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
