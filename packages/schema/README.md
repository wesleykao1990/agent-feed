# Schema package

The JSON Schemas in `contracts/` are the protocol source of truth. The
TypeScript files re-export generated types and runtime schema JSON; they must
not become a second handwritten contract. The Python SDK is generated from the
same schemas.

Protocol compatibility follows semantic versioning. Adding optional fields is minor-compatible; changing required fields, meanings, idempotency semantics, or trust boundaries requires a new protocol major version.

Run `python3 scripts/generate_protocol_types.py --write` to regenerate the
checked-in TypeScript and Python artifacts for all nine schemas. Use
`python3 scripts/generate_protocol_types.py --check` to detect generated-file
drift and `python3 scripts/check_protocol_compatibility.py` to check the
protocol-0.1 baseline. See `docs/11_protocol_compatibility.md` for the release
policy. Wire keys remain snake_case in both languages.
