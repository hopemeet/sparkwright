---
name: sparkwright-manual
description: Operational manual for running, configuring, debugging, and extending SparkWright itself. Do NOT use for testing or debugging the user's own application code (e.g. their login, auth, or business features) — that is outside SparkWright's scope.
triggers: trace session resume cron artifacts background task troubleshoot replay repair config provider model workspace permission tool skill MCP agent profile CLI TUI command flag
allowed-tools: shell
metadata:
  version: 0.1.0
---

# SparkWright Manual

Use this skill when the user asks for practical help with SparkWright commands,
configuration, capabilities, operations, troubleshooting, or contributor work.

This skill is an operational index. Its references are plain files: open the one
you need with a file-reading tool (e.g. read_file) using the full paths listed
under `<skill_files>` in the skill_load result. Do NOT call skill_load again —
this skill's body is already in context. Read only the reference needed for the
current task, not every reference by default.

## Routing

- For a single CLI syntax question, prefer running the local CLI help or reading
  the relevant CLI source before opening references. Read
  `references/cli-and-tui.md` when the task spans multiple commands or needs
  workflow guidance.
- For TUI startup, sessions, or interactive workflow questions, read
  `references/cli-and-tui.md`.
- For config paths, providers, models, workspace selection, permission modes,
  tool enable/disable/defer settings, or API key behavior, read
  `references/configuration.md`.
- For tools, skills, MCP, agent profiles, delegate tools, policy, approval, or
  capability-runtime wiring, read `references/capabilities.md`.
- For trace, artifacts, session repair/resume, cron, background tasks, durable
  task behavior, or troubleshooting, read `references/operations.md`.
- For repository layout, adding commands/tools/events/schemas, tests, release
  checks, or maintenance expectations, read `references/contributor.md`.

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
