# Decisions

- Freeze one sanitized aggregate contract before adding PostgreSQL, dashboard,
  alert, or hosted deployment adapters.
- Keep tenant scope mandatory while prohibiting tenant IDs from metric labels.
- Model provider, gateway, execution, validation, and delivery failures as
  independent bounded counts, never a single success flag.
