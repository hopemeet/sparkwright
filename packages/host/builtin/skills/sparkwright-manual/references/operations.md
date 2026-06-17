# Operations

Use this reference for trace, artifacts, sessions, cron, background tasks,
recovery, and troubleshooting.

## Trace Levels

- `minimal`: lifecycle and terminal facts.
- `standard`: useful debugging detail for normal runs.
- `debug`: deeper event payloads for development.

Run with:

```bash
--trace-level minimal
--trace-level standard
--trace-level debug
```

Session traces are stored under:

```txt
<workspace>/.sparkwright/sessions/<session-id>/trace.jsonl
```

## Useful Trace Events

For write paths, inspect:

- `workspace.write.requested`
- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `workspace.write.completed`
- `workspace.write.denied`
- `tool.failed`

For capability lifecycle, inspect:

- `skill.indexed`
- `skill.loaded`
- `mcp.server.prepared`
- `agent.profile.derived`

`mcp.server.prepared` includes resolved `toolNameMap` metadata when preparation
succeeds. On failure, inspect structured `errorCode`, `errorPhase`, and
`error.message` before falling back to the legacy metadata error string.

## Artifacts

Large or user-inspectable outputs should become artifacts instead of prompt
context. Workspace write proposals produce diff artifacts when approved.

Artifact files live under the session directory.

## Sessions

Use sessions to inspect or continue prior work:

```bash
npm exec sparkwright -- session summary <session-id> --workspace .
npm exec sparkwright -- session check <session-id> --workspace . --format text
npm exec sparkwright -- session repair <session-id> --workspace . --dry-run
npm exec sparkwright -- session resume <session-id> "continue" --workspace .
```

`session repair` defaults to a dry-run preview (no changes written). To actually
write the repair, pass `--apply`:

```bash
npm exec sparkwright -- session repair <session-id> --workspace . --apply
```

Use `run resume` for a stored run checkpoint:

```bash
npm exec sparkwright -- run resume <run-id> --session <session-id> --workspace .
```

## Cron

SparkWright includes a cron package and CLI command group. Jobs run in fresh
sessions. The cron tool is disabled inside scheduled runs to avoid recursive
job creation.

Common commands:

```bash
npm exec sparkwright -- cron create --schedule "every 1h" --prompt "task" --name name
npm exec sparkwright -- cron list
npm exec sparkwright -- cron update <job-id-or-name> --schedule "every 2h"
npm exec sparkwright -- cron pause <job-id-or-name>
npm exec sparkwright -- cron resume <job-id-or-name>
npm exec sparkwright -- cron remove <job-id-or-name>
npm exec sparkwright -- cron run <job-id-or-name> --model provider/model --yes
npm exec sparkwright -- cron tick --model provider/model --yes
```

Supported schedule inputs include delays, intervals, five-field cron
expressions, and ISO timestamps. See `packages/cron/src/schedule.ts`.

## Background Tasks

Use background tasks when a command may outlive the foreground turn:

- long builds or tests
- streaming shell output
- subprocesses needing cancellation
- work the agent should poll or observe later

`@sparkwright/shell-tool` can promote a long-running foreground command when
the host provides `foregroundTimeoutMs` and `onPromote`. The promoted task can
be observed through `task(action="get")` and `task(action="output")`.

Durable hosts should wire:

- `TaskManager`
- `TaskStore`
- `TaskNotificationSink`
- watchdog health checks
- startup recovery before accepting new work

Reference files:

- `docs/maintainer/ENVIRONMENT.md`
- `packages/agent-runtime/src/tasks/`
- `examples/promote-shell-to-task`

## Troubleshooting

CLI not found:

```bash
npm install
npm run build
```

Approval denied in non-interactive shell:

- Use `--yes` for deterministic smoke tests.
- Without `--yes`, `--write` approval can be denied and traced as
  `workspace.write.denied`.

Provider run fails before starting:

- Ensure provider/model are selected.
- Ensure `OPENAI_API_KEY` is set or config contains a key.
- For OpenAI-compatible gateways, set `OPENAI_BASE_URL` without a trailing
  `/responses`.

Workspace path escaped:

- Use workspace-relative paths.
- Avoid absolute paths and `..` traversal.

Trace too large or too small:

- Use `--trace-level minimal|standard|debug`.

Write proposed but not applied:

- Inspect `workspace.write.denied`, `approval.resolved`, and `tool.failed`.
- A changed file can cause `WORKSPACE_WRITE_CONFLICT`.
