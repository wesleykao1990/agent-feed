# Agent Feed protocol compatibility

Agent Feed protocol `0.1` has one contract source: the nine Draft 2020-12
schemas in `packages/schema/contracts/`. Generated producer/consumer types are
derived from those schemas and are not an additional wire contract:

- TypeScript: `packages/sdk/typescript/generated/protocol.ts`
- Python: `packages/sdk/python/agent_feed/generated/protocol.py`
- source manifest: `packages/sdk/generated/protocol-types.manifest.json`

The generator preserves wire property names exactly. A `source_ids` field is
`source_ids` in both generated languages; it is never silently converted to a
camelCase convenience field. Generated types describe the shape only. Runtime
validation, formats, limits, and cross-object invariants remain the job of the
JSON Schemas and application services. A `Finding` remains a producer
submission, not a verified consumer fact.

## Versioning policy

The transport version is pinned to `0.1`. Every schema that carries a
`protocol_version` property must use the literal value `0.1`; the liveness
expectation schema is intentionally a configuration/state object and has no
transport version field.

Changes are evaluated as follows:

- Adding an optional field is minor-compatible. Producers may omit it and
  consumers must tolerate its absence; generated artifacts and the compatibility
  baseline are regenerated together.
- Removing a required field, adding a required field, changing an existing
  field's JSON type, enum/const, reference, validation constraint, or wire
  meaning is breaking. Changes to idempotency behavior or trust boundaries are
  also breaking even if the JSON shape happens to remain unchanged.
- A breaking change requires a new protocol major version and a separately
  versioned schema set. Do not edit the protocol-0.1 baseline to hide a breaking
  change. The explicit `--write-baseline` command is reserved for an intentional
  protocol release review.

Because several 0.1 objects use `additionalProperties: false`, an optional
field addition still requires consumers that validate a closed object to adopt
the regenerated schema before they receive that field. The compatibility rule
means the field is not required from existing producers; rollout coordination
is still an operational responsibility.

## Checks

Regenerate artifacts after editing a schema:

```text
python3 scripts/generate_protocol_types.py --write
```

CI checks that generated files match the schemas, that all wire keys remain
snake_case, that the protocol literal remains `0.1`, and that no breaking
change has been made against the checked-in baseline:

```text
python3 scripts/generate_protocol_types.py --check
python3 scripts/check_protocol_compatibility.py
```

To intentionally establish a baseline for a reviewed protocol release, run
`python3 scripts/check_protocol_compatibility.py --write-baseline`, then review
the schema, generated artifacts, and baseline in the same change. The checks
do not make any claim that a finding or submitted evidence is verified.
