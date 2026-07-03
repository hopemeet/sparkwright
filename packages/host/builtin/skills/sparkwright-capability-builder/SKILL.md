---
name: sparkwright-capability-builder
description: Build SparkWright project capabilities from user intent. Use when the user wants to create, add, scaffold, wire, or configure a Skill, agent profile, delegate tool, MCP server, cron job, slash command, tool policy, or project capability.
triggers: create add scaffold build configure wire setup skill agent delegate MCP server cron schedule automation slash command project capability tool policy permission
allowed-tools: bash
metadata:
  version: 0.1.0
---

# SparkWright Capability Builder

Use this skill when the user wants to turn an intent into SparkWright project
capability state: Skills, agent profiles, delegate tools, MCP servers, cron
jobs, slash commands, tool filters, or related project config.

This skill is an implementation guide, not a general manual. If the user only
asks what a command or config field means, use `sparkwright-manual` instead.

## First Move

If you need the full decision tree, load this Skill's
`references/build-capabilities.md` resource through the Skill resource loader.
Do not read `references/build-capabilities.md` as a workspace file; it belongs
to this Skill package, not necessarily to the user's project.

Before writing files:

- For new project Skills, prefer `list_skills` followed by `create_skill`.
  Do not probe `.sparkwright/skills/<name>/SKILL.md` first; the file is
  expected to be missing before creation.
- For existing project Skill evolution, prefer `list_skills` followed by the
  deferred `update_skill` tool when available. That creates a draft proposal
  without applying it.
- Inspect the current workspace capability state with
  `npm exec sparkwright -- capabilities inspect --workspace . --format text`
  only when you are operating through the CLI rather than runtime tools.
- Prefer existing CLI scaffolds (`skills create`, `agents create`,
  `cron create`, `init --project`) over hand-authored files when they fit.
- Read the existing `.sparkwright/config.json` before modifying project config.
- Keep secrets out of project config. Use user config or environment variables
  for API keys and private credentials.

## Output Rules

- State which capability type you chose and why.
- Keep changes scoped to `.sparkwright/` or the requested capability files
  unless the user explicitly asks for broader code changes.
- For MCP and cron, include the command/config needed to inspect or validate the
  result.
- Do not claim the capability works until a relevant inspect, validate, or dry
  run command has passed.
