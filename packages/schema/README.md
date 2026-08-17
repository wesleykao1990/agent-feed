# Schema package

The JSON Schemas in `contracts/` are the protocol source of truth. The TypeScript files export generated/inferred types and must not become a second handwritten contract. The Python SDK is generated from the same schemas.

Protocol compatibility follows semantic versioning. Adding optional fields is minor-compatible; changing required fields, meanings, idempotency semantics, or trust boundaries requires a new protocol major version.
