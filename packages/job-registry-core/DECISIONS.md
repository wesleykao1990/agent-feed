# Decisions

- Keep logical definition, provider capability profile, and deployment binding
  as separate immutable version streams.
- Treat `active` as a fail-closed preflight state, not permission to make an
  external provider change.
- Store instruction digests or controlled references only; never instruction
  bodies or secrets.
