# Milestone 12 refactor debt

- Add persistence only through a new sidecar migration and repository; do not
  add utility columns to immutable producer findings or M8 assessment receipts.
- Reuse the pure normalizers in a future trusted consumer service rather than
  duplicating validation in HTTP or dashboard adapters.
- Keep fast deterministic contract tests after adding live PostgreSQL and
  multi-consumer acceptance harnesses.
