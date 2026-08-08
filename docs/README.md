# SparkWright Documentation

This directory is organized around the current product surface, not historical
planning notes. Start with the shortest path that matches what you are doing,
then move into reference docs when you need contracts.

## Start Here

| You want to...                                                    | Read                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Run SparkWright locally                                           | [User Manual](./guides/USER_MANUAL.md)                                                                             |
| Configure providers, models, paths, tools, skills, MCP, or agents | [Configuration](./guides/CONFIGURATION.md)                                                                         |
| Decide which capability shape to use                              | [Capability Design Guide](./guides/CAPABILITY_DESIGN_GUIDE.md)                                                     |
| Add a governed tool                                               | [Custom Tool Example](./guides/CUSTOM_TOOL_EXAMPLE.md)                                                             |
| Debug a failed run or session                                     | [Troubleshooting](./guides/TROUBLESHOOTING.md), then [State And Trace Model](./reference/STATE_AND_TRACE_MODEL.md) |
| Change runtime behavior                                           | [AI Task Index](./maintainer/AI_TASK_INDEX.md), then the relevant reference doc                                    |

## Guides

- [User Manual](./guides/USER_MANUAL.md) - CLI/TUI usage, traces, provider runs,
  ACP, and the basic workflow.
- [Configuration](./guides/CONFIGURATION.md) - provider setup, model selection,
  permission mode, workspace paths, TUI preferences, and capability settings.
- [Agent Profiles](./guides/AGENTS.md) - project agents, delegate tools, tool
  restrictions, and effective agent configuration.
- [Capability Design Guide](./guides/CAPABILITY_DESIGN_GUIDE.md) - when to use
  skills, tools, MCP, agent profiles, policy, approvals, and background tasks.
- [Automation And Background Tasks](./guides/AUTOMATION_AND_BACKGROUND_TASKS.md)
  - foreground tools, background tasks, and scheduled work.
- [Custom Tool Example](./guides/CUSTOM_TOOL_EXAMPLE.md) - a minimal governed
  tool with validation, policy, approval, and trace behavior.
- [Troubleshooting](./guides/TROUBLESHOOTING.md) - common setup and runtime
  failures.
- [External Delegates Example](./examples/external-delegates.md) - run
  external delegate profiles through the host.

## Reference

- [Architecture](./reference/ARCHITECTURE.md) - runtime architecture and package
  boundaries.
- [Protocol](./reference/PROTOCOL.md) - run, event, tool, approval, artifact,
  context, trace, and CLI protocol shapes.
- [Host Protocol](./reference/HOST_PROTOCOL.md) - host/client request,
  response, and event contract.
- [Extension Interfaces](./reference/EXTENSION_INTERFACES.md) - contracts for
  tools, context, policy, approvals, trace, commands, hooks, sub-agents, and
  usage tracking.
- [Run Events](./reference/RUN_EVENTS.md) - consumer-facing event rendering and
  projection.
- [State And Trace Model](./reference/STATE_AND_TRACE_MODEL.md) - state
  ownership, store responsibilities, and trace behavior.
- [Context Plane](./reference/CONTEXT_PLANE.md) - context assembly, prompt
  sections, cache stability, and extension points.
- [Provider Edge](./reference/PROVIDER_EDGE.md) - provider adapters, model
  routing, fallback, cancellation, and usage metadata.
- [Skills](./reference/SKILLS.md) - skill shape, loading, Skill Evolution, and
  trace reproducibility.
- [Streaming Loop Requirements](./reference/STREAMING_LOOP_REQUIREMENTS.md) -
  after-turn streaming and cancellation requirements.
- [Trace Extension Events](./reference/TRACE_EXTENSION_EVENTS.md) - extension
  event naming and metadata conventions.
- [Protocol Changelog](./reference/PROTOCOL_CHANGELOG.md)
- [Host Protocol Changelog](./reference/HOST_PROTOCOL_CHANGELOG.md)

## Maintainer

- [AI Task Index](./maintainer/AI_TASK_INDEX.md) - task-oriented entry points
  for common extension work.
- [Release Checklist](./maintainer/RELEASE_CHECKLIST.md) - release readiness
  gate.
- [Push Test Runbook](./maintainer/PUSH_TEST_RUNBOOK.md) - manual smoke tests
  before broad pushes.
- [Extension Release Checklist](./maintainer/EXTENSION_RELEASE_CHECKLIST.md) -
  checks for experimental extension packages.
- [Environment Notes](./maintainer/ENVIRONMENT.md) - local tooling and execution
  environment notes.
- [CLI Golden Path](./maintainer/CLI_GOLDEN_PATH.md) - current runnable CLI
  smoke path and expected outputs.

## Decisions

- [Architecture Decision Records](./adr/README.md) - durable design decisions
  and supersession history.
