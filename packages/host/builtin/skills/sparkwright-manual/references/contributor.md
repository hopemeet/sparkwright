# Contributor

Use this reference for repository maintenance tasks.

## Contribution Policy

SparkWright is pre-v0 and is not actively soliciting broad feature pull
requests yet. Small, well-scoped pull requests are appropriate for bug fixes,
documentation fixes, tests, and changes that clearly align with the current
runtime direction.

Start larger features, protocol changes, safety behavior changes,
trace/session changes, public API changes, or new default behavior with an
issue or design discussion before implementation.

## Checks

Expected setup:

```bash
npm install
npm run typecheck
npm test
```

Before a PR, run checks matching the change:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```

Full gate:

```bash
npm run check
```

## Pull Request Evidence

Every behavior-changing pull request should explain:

- the problem it solves, ideally with a linked issue;
- how to reproduce the issue or validate the workflow;
- observed behavior versus expected behavior;
- tests run, or why tests were not run;
- risk, especially public API, protocol, trace schema, safety policy, workspace
  mutation, session/resume, or default-behavior impact.

For runtime, CLI/TUI, tool execution, policy, approval, workspace mutation,
trace, session/resume, provider, or protocol changes, include relevant trace
evidence when possible: a redacted trace summary, timeline, verify output, or
focused trace excerpt, plus the command or workflow that produced it.

Do not attach secrets, credentials, private prompts, or unredacted local traces.
If trace evidence is not applicable, say why.

## Repository Shape

Primary directories:

- `packages/core`: run lifecycle, tools, context, policy, approval, trace.
- `packages/cli`: CLI entrypoint and command parsing.
- `packages/host`: standalone host process and runtime assembly.
- `packages/tui`: terminal UI.
- `packages/skills`: skill loading, matching, and projection.
- `packages/mcp-adapter`: MCP capability normalization.
- `packages/agent-runtime`: agent profiles, delegate helpers, and tasks.
- `packages/cron`: cron store, schedule parsing, runner, scheduler, and tool.
- `packages/coding-tools`: workspace tools.
- `packages/shell-tool`: shell execution tool.
- `schemas`: JSON schemas.
- `docs`: public documentation.
- `examples`: runnable examples.
- `skills`: repository-local skill packages.

## Add Or Change CLI Behavior

Start in:

- `packages/cli/src/cli.ts`

Update as needed:

- usage text
- argument parsing
- command handler
- tests for command behavior
- docs or this skill if user-visible behavior changes

## Add A Tool

Start in:

- `packages/core/src/tools.ts`
- package-specific tool surface if the tool belongs outside core

Read:

- `docs/guides/CUSTOM_TOOL_EXAMPLE.md`
- `docs/reference/EXTENSION_INTERFACES.md`

Update schemas only if the tool envelope changes. Normal new tools usually do
not require schema changes.

## Add A Skill Feature

Start in:

- `packages/skills/`
- `docs/reference/SKILLS.md`
- `schemas/skill-manifest.schema.json` if manifest shape changes

Skill scripts must not execute just because a skill was discovered. They must
enter as governed tools.

## Add MCP Behavior

Start in:

- `packages/mcp-adapter/`
- `schemas/mcp-server-config.schema.json` for config shape changes

Core should not import MCP protocol details.

## Add Agent Profile Or Delegation Behavior

Start in:

- `packages/agent-runtime/`
- `schemas/agent-profile.schema.json`

Parent restrictions must remain constraining for child agents.

## Add Cron Behavior

Start in:

- `packages/cron/src/`
- `packages/cli/src/cli.ts` for user-facing command changes
- `packages/host/src/tools.ts` if host-exposed tools change

Update operations docs and this skill for schedule syntax, job behavior, or
cron command changes.

## Add An Event Or Trace Shape

Start in:

- `packages/core/src/events.ts`
- `packages/core/src/trace.ts`
- `schemas/event.schema.json`
- `docs/reference/PROTOCOL.md`
- `docs/reference/RUN_EVENTS.md`

Add tests for trace levels and redaction if payload shape changes.

## Add Config Fields

Start in:

- `schemas/config.schema.json`
- host/CLI config loading code
- docs/config references

Document load order, overrides, and security behavior.

## Agent Skill Maintenance

When changing user-visible behavior, update the builtin manual skill under
`packages/host/builtin/skills/sparkwright-manual` in the same change. This
includes:

- CLI commands or flags
- TUI behavior
- config fields or load order
- provider/model behavior
- tools, skills, MCP, agent profiles, delegate tools, or capability runtime
- permission, approval, or policy semantics
- trace, artifacts, sessions, replay, or repair
- cron, background task, or host automation behavior
- contributor workflow or test commands

Do not mention external reference projects in this skill or related docs.
