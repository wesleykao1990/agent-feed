# ChatGPT monitoring integration

ChatGPT monitoring tasks are useful as independent sentinels because they can
periodically check for meaningful changes and remember prior runs. As verified
against the current OpenAI product documentation on 2026-08-18, web Scheduled
Tasks can use installed plugins and their connected MCP tools. Automatic Agent
Feed submission is therefore supported when the scheduled chat has the Agent
Feed plugin attached and all three lifecycle tools are callable.

Supported modes:

1. **Independent sentinel:** ChatGPT notifies a human; the production monitor remains separate.
2. **Manual run-bundle import:** the task returns protocol-valid JSON imported through `local-file`.
3. **Plugin-enabled Scheduled Task:** a web Scheduled Task may call the Agent
   Feed MCP lifecycle only when the installed plugin exposes `begin_run`,
   `submit_batch`, and `complete_run` in that scheduled chat.
4. **Production API monitor:** a separately scheduled OpenAI/Claude/custom worker uses the producer SDK and is the recommended automated path.

For private development and acceptance testing, OpenAI Secure MCP Tunnel can
connect the existing stdio server without a public listener. This preserves one
MCP implementation and one producer-service policy boundary. A public plugin
deployment requires stable HTTPS streamable HTTP and production
authentication; the tunnel is not a public publishing mechanism.

The ChatGPT skill therefore includes both direct tool submission and a
run-bundle fallback. Scheduled Tasks remain outside the production SLA because
the task, tunnel client, local MCP process, and PostgreSQL database all have
separate liveness conditions. See
`docs/operations/chatgpt-scheduled-task.md` for the operator workflow.

## Capacity boundary for ChatGPT Scheduled Tasks

Scheduled Tasks are limited to a few high-value independent sentinels on one
account. Web tasks can use uploaded context, connected tools, skills, and
plugins available to the chat, but cannot directly use a local project folder.
They are not a per-source monitoring tier for a large registry. The separately
scheduled API producer remains the scalable production path.

A ChatGPT sentinel also needs external liveness checking: tasks may pause after inactivity and deleting the associated chat pauses the task. Silence must never be interpreted as healthy monitoring.

A missing run is an overdue liveness incident, not a zero-finding result.
