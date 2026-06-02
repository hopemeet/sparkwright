---
name: sparkwright-manual
description: Operational manual for helping users run, configure, debug, and extend SparkWright.
allowed-tools: shell
metadata:
  version: 0.1.0
---

# SparkWright Manual

Use this skill when the user asks for practical help with SparkWright commands,
configuration, capabilities, operations, troubleshooting, or contributor work.

This skill is an operational index. Load only the reference file needed for the
current task. Do not load every reference by default.

## Routing

- For a single CLI syntax question, prefer running the local CLI help or reading
  the relevant CLI source before loading references. Use
  `references/cli-and-tui.md` when the task spans multiple commands or needs
  workflow guidance.
- For TUI startup, sessions, or interactive workflow questions, use
  `references/cli-and-tui.md`.
- For config paths, providers, models, workspace selection, permission modes,
  tool enable/disable/defer settings, or API key behavior, use
  `references/configuration.md`.
- For tools, skills, MCP, agent profiles, delegate tools, policy, approval, or
  capability-runtime wiring, use `references/capabilities.md`.
- For trace, artifacts, session repair/resume, cron, background tasks, durable
  task behavior, or troubleshooting, use `references/operations.md`.
- For repository layout, adding commands/tools/events/schemas, tests, release
  checks, or maintenance expectations, use `references/contributor.md`.

## Operating Rules

- Prefer facts from this repository: source files, schemas, docs, examples, and
  local command output.
- If a capability is not implemented, state that directly and point to the
  current implemented path.
- Do not invent command flags or config fields. Verify uncertain CLI behavior
  with source or local command output.
- Do not expose or mention external projects as references for this manual.
- Treat config changes as governed workspace changes when an agent proposes
  them: policy, approval, artifact, and trace should apply.
- For command examples, use repository-local commands unless the user asks for
  installed-package usage.

## Maintenance

Update this skill or the relevant reference when user-visible SparkWright
behavior changes:

- CLI commands or flags
- TUI behavior
- config fields, paths, or load order
- provider/model behavior
- tools, skills, MCP, agent profiles, delegate tools, or capability runtime
- permission, approval, or policy semantics
- trace, artifacts, sessions, replay, or repair
- cron, background task, or host automation behavior
- contributor workflow, test commands, or release gates
