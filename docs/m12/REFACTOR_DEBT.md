# Milestone 12 refactor debt

- No structural refactor is required for the persistence/service checkpoint:
  the pure core, trusted service, and PostgreSQL adapter remain separate.
- Add bounded aggregate projections without introducing mutable source rows or
  floating-point ratios.
- Add consumer adapters behind the trusted service instead of importing
  provider SDKs into the core or persistence packages.
- Keep the live credential smoke opt-in and outside hosted CI; CI must not
  depend on personal ChatGPT or OpenAI credentials.
