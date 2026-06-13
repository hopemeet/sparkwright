# Sparkwright Documentation

This directory is organized by reader intent. Start with guides, use reference docs when you need implementation contracts, and use maintainer docs only for release or repository maintenance work.

## Guides

- [User Manual](./guides/USER_MANUAL.md) - run the CLI/TUI, inspect trace output, and understand the basic workflow.
- [Configuration](./guides/CONFIGURATION.md) - configure providers, models, permission mode, workspace, TUI preferences, and capability runtime settings.
- [Agent Profiles](./guides/AGENTS.md) - define project agents, expose delegate tools, restrict tools, and inspect effective agent configuration.
- [Capability Design Guide](./guides/CAPABILITY_DESIGN_GUIDE.md) - decide when to use skills, tools, MCP, agent profiles, policy, approvals, and background tasks.
- [Custom Tool Example](./guides/CUSTOM_TOOL_EXAMPLE.md) - add a tool with validation, policy, approval, and trace behavior.
- [Automation And Background Tasks](./guides/AUTOMATION_AND_BACKGROUND_TASKS.md) - understand long-running commands and host-owned scheduling.
- [Troubleshooting](./guides/TROUBLESHOOTING.md) - diagnose common local setup and runtime issues.

## Reference

- [Architecture](./reference/ARCHITECTURE.md) - runtime architecture and package boundaries.
- [Extension Interfaces](./reference/EXTENSION_INTERFACES.md) - extension contracts for tools, context, policy, approvals, trace, commands, hooks, sub-agents, and usage tracking.
- [Protocol](./reference/PROTOCOL.md) - run, event, tool, approval, artifact, context, trace, and CLI protocol shapes.
- [Host Protocol](./reference/HOST_PROTOCOL.md) - host/client request, response, and event contract.
- [Run Events](./reference/RUN_EVENTS.md) - consumer-facing guide to rendering and projecting run events.
- [State And Trace Model](./reference/STATE_AND_TRACE_MODEL.md) - state ownership, store responsibilities, and trace behavior.
- [Context Plane](./reference/CONTEXT_PLANE.md) - context assembly, prompt sections, cache stability, and related extension points.
- [Provider Edge](./reference/PROVIDER_EDGE.md) - provider adapters, model routing, fallback, cancellation, and usage metadata.
- [Skills](./reference/SKILLS.md) - supported skill shape, loading strategy, Skill Evolution workflow, and trace reproducibility.
- [Streaming Loop Requirements](./reference/STREAMING_LOOP_REQUIREMENTS.md) - after-turn streaming and cancellation requirements.
- [Trace Extension Events](./reference/TRACE_EXTENSION_EVENTS.md) - extension event naming and metadata conventions.
- [Protocol Changelog](./reference/PROTOCOL_CHANGELOG.md)
- [Host Protocol Changelog](./reference/HOST_PROTOCOL_CHANGELOG.md)

## Maintainer

- [Release Checklist](./maintainer/RELEASE_CHECKLIST.md) - required checks and release readiness gate.
- [Extension Release Checklist](./maintainer/EXTENSION_RELEASE_CHECKLIST.md) - checks for experimental extension packages.
- [Push Test Runbook](./maintainer/PUSH_TEST_RUNBOOK.md) - detailed manual smoke tests before broad pushes.
- [AI Task Index](./maintainer/AI_TASK_INDEX.md) - AI-maintainer map from common tasks to source files and docs.
- [Environment Notes](./maintainer/ENVIRONMENT.md) - local tooling and execution environment notes.
- [CLI Golden Path](./maintainer/CLI_GOLDEN_PATH.md) - current runnable CLI smoke path and expected outputs.

## Archive

These files preserve design history or superseded planning material. They should not be treated as the current user path.

- [Project Config Surface](./archive/PROJECT_CONFIG_SURFACE.md)
- [Capability Host/TUI Plan](./archive/CAPABILITY_HOST_TUI_PLAN.md)
- [Skill, MCP, And Agent Capability Model](./archive/SKILL_MCP_AGENT_CAPABILITY_MODEL.md)
- [Harness Principles](./archive/HARNESS_PRINCIPLES.md)
- [Harness Component Model](./archive/HARNESS_COMPONENT_MODEL.md)
- [Reference Notes](./archive/REFERENCE_NOTES.md)

## Decisions

- [Architecture Decision Records](./adr/README.md)
