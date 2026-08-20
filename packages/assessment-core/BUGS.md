# Assessment-core bugs and limitations

## Open

- This package does not persist policies, assessor registrations, runs, or
  assessments. A storage adapter must enforce append-only reassessment and
  trusted authority lookup.
- Artifact references are identity/provenance only. The package does not fetch,
  verify, retain, or delete external artifact bytes.
- Policy evaluation accepts positional authority values for a batch helper;
  durable adapters should bind each authority to an immutable registration
  version before calling the pure helper.

## Fixed in this slice

- Producer submissions cannot include assessor identity/type/independence or
  technical run status, including through metadata.
- Unknown and not-applicable telemetry values are required to remain null.
- Artifact references reject inline content, credential-shaped values, query or
  fragment material, and signed URL forms.
