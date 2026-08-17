# local-file adapter

Imports a validated run-bundle JSON file. This is the safe fallback for agent environments, including ChatGPT Scheduled Tasks, that cannot call outbound webhooks or MCP tools.

The first runnable path is:

    cd prototype
    npm ci
    npm run import:file -- ../examples/run-bundle.zero-findings.example.json

The importer validates protocol 0.1 structure and semantic invariants before
changing state. It rejects secret-bearing submitted evidence and preserves
security flags and the original untrusted wire payload. It never promotes a
finding or submitted evidence into a consumer-domain fact.
