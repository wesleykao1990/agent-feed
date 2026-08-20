# `@agent-feed/assessment-core`

Pure, provider-neutral Milestone 8 contracts for validation policies, job
assessments, operational receipts, telemetry, and artifact identity. The
package has no database, HTTP, provider SDK, scheduler, model, prompt, or blob
store dependency.

## Assessment submissions

`normalizeAssessment` accepts only evidence that belongs to the assessment:

- assessment kind and verdict;
- typed failure stage/class and stop reason;
- bounded timestamps, summary, and safe metadata;
- declared budget state and limit;
- explicit usage metric state, value, and provenance; and
- bounded artifact key/kind, lower-case SHA-256, optional opaque identity and
  reference, and optional byte length/media type/provenance.

The input deliberately has no assessor identity, assessor type, independence,
or technical run status. Those values are trusted authority/run facts supplied
separately by a persistence adapter. Unknown or not-applicable telemetry uses a
null value; it is never converted to zero. Observed telemetry requires a
non-negative safe-integer value and non-unknown provenance.

All normalization is fresh and deterministic. Set-like arrays are sorted by
stable keys, timestamps are canonical UTC, and `hashAssessmentRequest` hashes
the canonical normalized request. Idempotency keys and server-assigned fields
are not part of that hash.

## Policy authority

Policy v1 contains required assessment kinds, a minimum independence of `self`
or `independent`, and a declared-budget requirement (`required`, `optional`, or
`not_applicable`). Use `checkPolicyCompatibility` with a separately resolved
`AssessorAuthority`. A `producer_self_check` can never satisfy an independent
minimum by claiming independence in its submission.

```ts
import {
  checkPolicyCompatibility,
  hashAssessmentRequest,
  normalizeAssessment,
} from "@agent-feed/assessment-core";

const assessment = normalizeAssessment({
  runId: "run-42",
  assessmentKind: "quality",
  verdict: "passed",
  usage: [{
    metric: "wall_time_ms",
    state: "observed",
    value: 231,
    provenance: "executor_measured",
  }],
  artifactReferences: [{
    artifactKey: "report",
    artifactKind: "json_report",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    reference: "object://reports/run-42",
  }],
});

const requestHash = hashAssessmentRequest(assessment);
const proofGate = checkPolicyCompatibility(
  {
    requiredAssessmentKinds: ["quality"],
    minimumIndependence: "independent",
    declaredBudgetRequirement: "optional",
  },
  assessment,
  { assessorType: "validation_service", independence: "independent" },
);
```

Artifact references are opaque identity claims only. Inline content, blobs,
data/base64 values, credentials, query/fragment material, and signed URL
material are rejected. A storage adapter remains responsible for resolving a
reference and verifying the bytes against the recorded hash.

This package is the pure contract layer. A follow-up persistence adapter must
resolve tenant/run/policy/assessor registration authority transactionally and
append a new assessment for every reassessment; it must not mutate a prior
receipt.
