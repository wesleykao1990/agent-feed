# `@agent-feed/schema`

This directory publishes the versioned Agent Feed protocol contract artifact.
The package version is `0.1.1`; the wire protocol carried by the schemas remains
`0.1`. Those are deliberately separate: a package build or tooling fix does
not change the wire contract.

The JSON Schemas in `contracts/` are the only contract source of truth. The
TypeScript declarations bundled into `dist/generated/protocol.d.ts` are copied
from the checked-in generator output at
`packages/sdk/typescript/generated/protocol.ts` during the build. They must not
be edited by hand. Run the repository generators before publishing when a
schema changes:

```sh
python3 scripts/generate_protocol_types.py --write
python3 scripts/generate_protocol_types.py --check
python3 scripts/check_protocol_compatibility.py
```

## Build and verify

The package is intentionally standalone and has a lockfile so a clean checkout
can reproduce the build:

```sh
npm ci
npm run verify
```

`verify` compiles the runtime entrypoint, checks that the packaged JSON bytes
match `contracts/`, exercises the nine runtime exports, and runs `npm pack` to
confirm that the tarball includes the runtime JavaScript, declarations, and
contracts without staging files. `npm pack`/`npm publish` also run the build
through the `prepack` hook, so a stale or missing `dist/` directory cannot be
silently released.

## Consumer usage

The first release lane publishes a GitHub release asset from the immutable
`schema-v0.1.1` tag; it does not publish to npm. Consumers should pin the exact
asset URL and commit the resulting package-lock `resolved` and `integrity`
records:

```sh
npm install --save-exact \
  https://github.com/wesleykao1990/agent-feed/releases/download/schema-v0.1.1/agent-feed-schema-0.1.1.tgz
```

```ts
import {
  PROTOCOL_VERSION,
  beginRunSchema,
  schemas,
  type BeginRunRequest,
} from "@agent-feed/schema";

const protocol = PROTOCOL_VERSION; // "0.1"
const validator = makeJsonSchemaValidator(beginRunSchema);
const request: BeginRunRequest = /* producer request */ {} as BeginRunRequest;
validator(request);
console.log(Object.keys(schemas));
```

The direct contract files are also exported for validators that load JSON by
path, for example `@agent-feed/schema/contracts/submit-batch.schema.json`.
Tag and release assets are immutable after publication; the consumer
lockfile's `resolved` URL plus `integrity` field is the release pin. Before
publishing, record the exact `sha512-...` value printed by the artifact builder
in the consuming project's release manifest and review it as part of the
integration gate. Do not use a branch, GitHub source archive, workspace link,
floating semver range, or local `file:` dependency as release evidence.

Protocol compatibility follows semantic versioning. Adding optional fields is
minor-compatible; changing required fields, meanings, idempotency semantics, or
trust boundaries requires a new protocol major version. Wire keys remain
snake_case in both languages. See `docs/11_protocol_compatibility.md` for the
full release policy.
