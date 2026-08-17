# Agent Feed submission skill for Claude

1. Begin a run with expected scope and a stable idempotency key.
2. Submit findings and evidence in bounded batches.
3. Keep discovery claims separate from verified consumer-domain facts.
4. Preserve source URLs, exact locators, publication/effective dates, and unresolved ambiguity.
5. Complete every run with actual scope and accurate status, including zero-finding, partial, and failed runs.
6. Never retry with a new idempotency key merely to bypass an error.
7. Never submit secrets or unnecessary personal data.
