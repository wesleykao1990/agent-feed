# ChatGPT monitoring integration

ChatGPT monitoring tasks are useful as independent sentinels because they can periodically check for meaningful changes and remember prior runs. Current Scheduled Tasks do not provide webhooks, so Agent Feed must not assume automatic outbound submission from a scheduled task.

Supported modes:

1. **Independent sentinel:** ChatGPT notifies a human; the production monitor remains separate.
2. **Manual run-bundle import:** the task returns protocol-valid JSON imported through `local-file`.
3. **Tool-enabled runtime:** an interactive or agent runtime may call Agent Feed MCP/REST only when outbound tool support has been verified for that deployment.
4. **Production API monitor:** a separately scheduled OpenAI/Claude/custom worker uses the producer SDK and is the recommended automated path.

The ChatGPT skill therefore includes both tool submission and run-bundle fallback. Scheduled Tasks are not part of the production SLA.

## Capacity boundary for ChatGPT Scheduled Tasks

As reviewed on 2026-08-17, plan-level active-task caps are small (Go 3, Plus 5, Business/Edu 10, Pro/Enterprise 15), the minimum interval is 60 minutes, and tasks do not support custom GPTs, task-local file uploads, or project-file access. Scheduled Tasks are therefore limited to a few high-value independent sentinels on one account. They are not a per-source monitoring tier for a 140-source registry. The separately scheduled API producer remains the scalable path.

A ChatGPT sentinel also needs external liveness checking: tasks may pause after inactivity and deleting the associated chat pauses the task. Silence must never be interpreted as healthy monitoring.

A missing run is an overdue liveness incident, not a zero-finding result.
