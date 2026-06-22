# Automation And Background Tasks

SparkWright distinguishes foreground tool calls, background tasks, and scheduled
automation. Foreground calls and background tasks are runtime primitives.
Scheduled jobs are implemented through `@sparkwright/cron` and host/CLI wiring,
while the core run loop remains focused on governed runs.

## Foreground Tool Calls

A normal tool call runs inside the current agent turn. It should finish quickly
enough for the model to observe the result and continue.

Use foreground tools for:

- file reads
- small shell commands
- metadata inspection
- narrow API calls
- validation checks

## Background Tasks

Use a background task when work may outlive the foreground turn:

- long builds or tests
- streaming shell output
- subprocesses that need cancellation
- jobs the agent should poll or observe later

`@sparkwright/shell-tool` can promote a long-running command into a task when
the host provides `foregroundTimeoutMs` and `onPromote`. The task can then be
observed with `task(action="get")` and `task(action="output")`.

Read [Environment Notes](../maintainer/ENVIRONMENT.md) for the durable wiring example.

## Durable Task Pattern

A durable host should wire:

- `TaskManager` for task lifecycle
- `TaskStore` for task state
- `TaskNotificationSink` for terminal events
- a watchdog for idle and wall-clock timeouts
- recovery on startup before accepting new work

Terminal task notifications should be injected into the next model turn through
`createStreamingRun({ notificationSources })`. This lets the agent react to a
completed or failed background task without busy polling.

## Scheduled Automation

SparkWright ships `@sparkwright/cron` for scheduled jobs. Jobs are stored in a
cron store, can be managed through the CLI, and run in fresh sessions. The cron
tool is disabled inside scheduled runs so a scheduled job does not recursively
create or run more scheduled jobs from inside its own agent session.

The cron store is user runtime state. By default it lives under
`~/.local/state/sparkwright/cron`, or under
`$XDG_STATE_HOME/sparkwright/cron` when `XDG_STATE_HOME` is set. It is not
stored in `~/.sparkwright` and is not project-authored under
`<workspace>/.sparkwright`.

Common CLI commands:

```bash
npm exec sparkwright -- cron create --schedule "every 1h" --prompt "task" [--name name] [--skill name] [--repeat n|forever]
npm exec sparkwright -- cron list
npm exec sparkwright -- cron update <job-id-or-name> [--schedule text] [--prompt text] [--name text]
npm exec sparkwright -- cron pause <job-id-or-name>
npm exec sparkwright -- cron resume <job-id-or-name>
npm exec sparkwright -- cron remove <job-id-or-name>
npm exec sparkwright -- cron run <job-id-or-name> [--model provider/model] [--yes]
npm exec sparkwright -- cron tick [--model provider/model] [--yes]
```

The core run loop still does not own scheduler wakeups. Scheduling remains
host-owned because hosts know:

- identity and authorization
- deployment environment
- wakeup durability
- retry policy
- notification surface
- whether a task should start a new run or resume an existing session

A good scheduler integration starts a normal governed run:

```txt
cron / host scheduler
  -> create run with goal, workspace, agent profile, and config
  -> execute tools through policy and approval
  -> persist artifacts and trace
  -> notify user or downstream system
```

The scheduled trigger is only a source of intent. It should not bypass approval,
workspace boundaries, provider configuration, or trace.

## Automation Design Rules

- Keep scheduling outside core until several hosts need the same contract.
- Store schedule definitions as host configuration or workspace files.
- Route agent-written schedule changes through governed workspace writes.
- Record schedule id, trigger time, and initiating principal in run metadata.
- Prefer idempotent goals and explicit workspaces.
- Give scheduled runs tighter budgets than interactive runs by default.
- Require approval for schedules that can write files, call external systems, or spend meaningful provider budget.

## Current Status

Implemented today:

- foreground shell execution boundary
- shell-tool foreground-to-background promotion
- task manager primitives
- in-memory and file-backed task state patterns
- notification sources for injecting terminal task events into later turns
- cron store, schedule parsing, runner, scheduler helpers, and CLI commands

Not implemented as a built-in core feature:

- durable schedule registry
- recurring wakeup service
- hosted retry orchestration
- schedule marketplace or UI
