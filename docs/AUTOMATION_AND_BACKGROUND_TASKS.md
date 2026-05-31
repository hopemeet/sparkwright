# Automation And Background Tasks

Sparkwright distinguishes foreground tool calls, background tasks, and scheduled
automation. The first two have runtime primitives today. Scheduling is a host
responsibility until the contract is proven.

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
observed with `task_get` and `task_output`.

Read [Environment Notes](ENVIRONMENT.md) for the durable wiring example.

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

Sparkwright does not currently ship a cron scheduler as a core runtime feature.
That is intentional. Scheduling should be owned by the host because hosts know:

- identity and authorization
- deployment environment
- wakeup durability
- retry policy
- notification surface
- whether a task should start a new run or resume an existing session

A good scheduler integration should start a normal governed run:

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

Not implemented as a built-in core feature:

- cron parser
- durable schedule registry
- recurring wakeup service
- hosted retry orchestration
- schedule marketplace or UI
