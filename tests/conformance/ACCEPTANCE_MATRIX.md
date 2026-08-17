# Milestone 0/1 Conformance Acceptance Matrix

The suite in `tests/conformance/conformance.test.ts` exercises the protocol
through the public prototype surfaces (`RunBundleImporter`, `AgentFeedStore`,
`importRunBundleFile`, REST `/import-run-bundle`, and the HMAC helpers). It is
intentionally separate from the prototype unit tests so contract regressions
are visible as a protocol-level acceptance result.

Run it with:

```sh
npm run conformance:test
```

| ID | Acceptance area | Fixture or input | Public surface | Expected result | Test |
| --- | --- | --- | --- | --- | --- |
| M0-01a | `begin-run` schema | `examples/rewards-optimizer/begin-run.example.json` | AJV contract validator | Valid snake_case request | M0-01 |
| M0-01b | `complete-run` schema | `examples/rewards-optimizer/complete-run.example.json` | AJV contract validator | Valid terminal request | M0-01 |
| M0-01c | `delivery-event` schema | `examples/rewards-optimizer/delivery-event.example.json` | AJV contract validator | Valid delivery event | M0-01 |
| M0-01d | `evidence` schema | Evidence from `run-bundle.example.json` | AJV contract validator | Valid submitted evidence | M0-01 |
| M0-01e | `finding` schema | Finding from `run-bundle.example.json` | AJV contract validator | Valid unverified finding | M0-01 |
| M0-01f | `run-bundle` schema | `run-bundle.example.json`, zero, hostile | AJV + importer | All valid; nested refs resolve | M0-01 |
| M0-01g | `run-envelope` schema | `examples/rewards-optimizer/run-envelope.example.json` | AJV contract validator | Valid normalized envelope | M0-01 |
| M0-01h | `stream-expectation` schema | `examples/stream-expectation.example.json` | AJV contract validator | Valid liveness state | M0-01 |
| M0-01i | `submit-batch` schema | `examples/rewards-optimizer/submit-batch.example.json` | AJV contract validator | Valid non-empty batch | M0-01 |
| M0-01j | Example inventory | Six rewards examples, zero-finding, hostile, stream expectation (9 total) | Fixture loader | Every checked-in example is readable JSON | M0-01 |
| M0-02 | Wire naming and preservation | Rewards run bundle | `RunBundleImporter.import` | snake_case accepted; internal fields normalize to camelCase; original wire payload remains available; camelCase wire key rejected | M0-02 |
| M0-03 | Cross-object semantic invariants | Mutated valid bundle | `RunBundleImporter.import` | Run IDs, sequences, IDs, evidence refs, completion time/counts, source stats, and secret handling reject before state mutation | M0-03 |
| M0-04 | Bundle retry and payload drift | Rewards run bundle | `RunBundleImporter.import` | Exact retry returns `imported:false` and same hash; any payload drift conflicts; state remains unchanged | M0-04 |
| M0-05 | Lifecycle retry and terminal immutability | Synthetic begin/batch/complete requests | `AgentFeedStore` | Exact begin/batch/complete retries are idempotent; drift conflicts; post-terminal writes are rejected | M0-05 |
| M0-06 | Completion reconciliation and zero findings | Zero-finding bundle plus count-drift mutation | `RunBundleImporter`, `AgentFeedStore` | Completed empty run is stored and distinct from an unknown run; count drift is rejected | M0-06 |
| M0-07 | Hostile input handling | `examples/security/hostile-run-bundle.json` | `RunBundleImporter.import` | Embedded instruction and authority escalation flags survive unchanged as untrusted data | M0-07 |
| M1-01 | Body and batch limits | >1 MiB body; 101 evidence items | `RunBundleImporter.importJson`, REST import | Both reject with `body_too_large`/413 or `batch_limit_exceeded` before persistence | M1-01 |
| M1-02 | Local-file/REST parity | Zero-finding bundle | `importRunBundleFile`, REST import | Same normalized result and payload hash; REST retry is 200/not imported | M1-02 |
| M1-03 | Absent-run distinction over REST | Unknown ID and imported zero run | REST GET `/runs/:id` | Unknown run is 404; completed zero-finding run is 200 with empty arrays | M1-03 |
| M1-04 | HMAC replay protection | Fixed body, timestamp, secret | `signBody`, `verifyBody` | Same request and boundary timestamp verify; stale, altered-body, and wrong-secret replays fail | M1-04 |

The matrix is acceptance coverage, not a claim that the prototype is a
production transport. In particular, the REST conformance path intentionally
uses the validated run-bundle ingress; lower-level prototype endpoints remain
thin internal lifecycle surfaces.
