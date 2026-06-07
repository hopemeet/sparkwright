# Configuration

Sparkwright configuration is user-editable JSON shared by the CLI, TUI, and
host runtime. The schema is
[schemas/config.schema.json](../../schemas/config.schema.json).

Use this guide in two passes: first choose the right configuration layer, then
copy the smallest recipe that matches the job. The full schema exists for
editors and validation, but most users should not need to understand every
field before running SparkWright.

## Choose The Right Layer

```txt
Personal config: ~/.config/sparkwright/config.json
  Put private provider settings here: model, providers, API keys, personal TUI
  preferences. This file is created by `sparkwright init` and is chmod 600.

Project config: <workspace>/.sparkwright/config.json
  Put team-safe runtime defaults here: permissionMode, tools, skills, MCP,
  agents. This file is safe to commit when it does not contain secrets.

Temporary overrides: SPARKWRIGHT_CONFIG, environment variables, CLI flags
  Use these for one-off runs, CI jobs, or local experiments.
```

Do not put provider API keys in project config. Keep credentials in the user
file or environment variables.

## Load Order

Configuration is loaded in this order, with later sources overriding earlier
ones:

1. `~/.config/sparkwright/config.json`
2. `<workspace>/.sparkwright/config.json`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

The `providers` map is merged by provider key. Most other fields are replaced
wholesale by the later source. In particular, `capabilities` is not deep-merged
across files; put related project capability settings in the same project
config file when possible.

Precedence, weak to strong:

```txt
convention markdown files < user config < project config < $SPARKWRIGHT_CONFIG / CLI
```

That means markdown files are a team-default convenience layer, while
`config.json` remains the precise-control layer.

## Scaffold

Scaffold the two common layers separately:

```bash
sparkwright init             # ~/.config/sparkwright/config.json
sparkwright init --project   # <workspace>/.sparkwright/config.json
```

`sparkwright init` creates a personal provider template. Set the `apiKey` for
the provider you want, or leave keys out of the file and use environment
variables.

`sparkwright init --project` creates a committable project template plus the
convention directories:

```txt
.sparkwright/skills
.sparkwright/agents
.sparkwright/command
```

Inspect what the host will actually prepare:

```bash
sparkwright capabilities inspect --workspace . --format text
```

## Quick Recipes

### Local Smoke Test

Use the built-in deterministic provider when you want an offline smoke test:

```json
{
  "model": "deterministic",
  "permissionMode": "default",
  "workspace": "."
}
```

The reserved `deterministic` provider is built in and does not need a
`providers` entry.

### Personal OpenAI-Compatible Provider

Put this in `~/.config/sparkwright/config.json`:

```json
{
  "model": "openai/gpt-5.4-mini",
  "providers": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "replace-me",
      "models": {
        "gpt-5.4-mini": {},
        "gpt-5.4": {}
      }
    }
  }
}
```

`OPENAI_API_KEY` overrides provider `apiKey` when set. `OPENAI_BASE_URL`
overrides provider `baseURL` when set.

Store config files containing API keys privately. Provider keys are plaintext
in config.

### Safe Project Defaults

Put project-wide behavior in `<workspace>/.sparkwright/config.json`:

```json
{
  "permissionMode": "default",
  "capabilities": {
    "tools": {
      "disabled": ["shell"],
      "defer": ["mcp_*"]
    },
    "skills": {
      "includeLoaderTool": true,
      "loadSelectedSkills": false,
      "resourceFileLimit": 8
    },
    "mcp": {
      "servers": []
    }
  }
}
```

This is intentionally not a full allowlist. Omitting `tools.enabled` lets the
host start from its available tools, then removes `shell` and defers MCP schemas
when supported.

### Add A Stdio MCP Server

Add a server under project `capabilities.mcp.servers`:

```json
{
  "capabilities": {
    "mcp": {
      "servers": [
        {
          "type": "stdio",
          "name": "workspace",
          "command": "node",
          "args": ["./tools/workspace-mcp.js"],
          "cwd": ".",
          "enabled": true
        }
      ],
      "defaultTimeoutMs": 30000,
      "namePrefix": "mcp",
      "defaultPolicy": {
        "risk": "risky",
        "requiresApproval": true
      }
    }
  }
}
```

MCP `cwd` resolves from the config file that declares it. Prefer
`requiresApproval: true` for tools that can touch workspace state,
credentials, network services, or external systems.

### Add A Reviewer Agent

Project agent profiles can be committed as markdown files under:

```txt
<workspace>/.sparkwright/agents/<id>.md
```

Example:

```md
---
name: Reviewer
description: Inspect changes for correctness, risk, and missing tests.
mode: child
allowedTools: [read_file, glob_paths]
deniedTools: [shell]
maxSteps: 4
---

Review the proposed change. Focus on correctness, regressions, and missing
tests. Report findings with file references.
```

Profiles describe role guidance and constraints. They do not grant authority by
themselves. Only entries listed in `capabilities.agents.delegateTools` become
callable parent-run tools, and those tools still go through policy, approval,
validation, and trace.

## File-Authored Commands

Project slash commands can be committed as markdown files under:

```txt
<workspace>/.sparkwright/command/<name>.md
```

Each file becomes a slash command named after the filename. The optional
frontmatter fields are:

```md
---
description: Explain what the command does
model: deterministic
subtask: false
---

Prompt text sent when the command runs.

Optional user input: $ARGUMENTS
First positional argument: $1
```

Commands return a start-run intent; the embedder decides how to launch the run.
They do not bypass the normal run boundary.

Command bodies may include fixed shell interpolation with `` !`...` ``. Shell
spans are classified by the same safety floor used for model-invoked shell:
denied commands fail, commands that require approval need an approver, and only
allowed or explicitly approved commands execute. User arguments are not spliced
inside shell spans; `` !`grep $1 src` `` runs literally with `$1` untouched.
Put user arguments in prompt text instead.

## Field Map

- `model`: active model in `provider/model` form. The reserved
  `deterministic` provider is built in.
- `providers`: named provider definitions. Keep provider keys in personal
  config, not project config.
- `permissionMode`: default run permission mode.
- `workspace`: default workspace root. Relative paths resolve from the config
  file that defines them.
- `capabilities.tools`: tool enable, disable, and defer filters.
- `capabilities.skills`: Skill roots and loading behavior.
- `capabilities.mcp`: MCP server definitions and default policy.
- `capabilities.agents`: agent profiles and delegate tools.
- `theme`, `mouse`, `keybindings`: TUI-only preferences.

The config schema permits a top-level `"$schema"` so editors can offer
completion and validation, but the scaffolds do not emit one yet. Add
`"$schema"` yourself once the schema is published.

## Permission Modes

- `plan`: prefer read-only planning.
- `default`: normal approval behavior for risky actions.
- `accept_edits`: accept workspace edits while preserving other policy gates.
- `dont_ask`: avoid interactive approval prompts where the host permits it.
- `bypass_permissions`: trusted-host escape hatch.

Deny rules should remain authoritative. Skills, MCP servers, and agent profiles
do not grant authority by themselves.

## Tool Filters

`tools.enabled`, `tools.disabled`, and `tools.defer` accept tool names or `*`
wildcard patterns.

- `enabled`: optional allowlist. Omit it to allow all host-assembled tools
  before other filters apply.
- `disabled`: removes matching tools.
- `defer`: keeps matching tools discoverable while delaying their full schemas
  when the tool does not force eager loading.

These settings only decide which tools the host prepares before a run. Tool
execution still goes through policy, approval, validation, and trace.

The CLI can manage user-level tool settings in
`~/.config/sparkwright/config.json`:

```bash
sparkwright tools list --format text
sparkwright tools enable read_file glob_paths
sparkwright tools disable shell
sparkwright tools defer "mcp_*"
```

## Skill Loading

Skill roots and MCP `cwd` values resolve from the config file that declares
them. `allowedSkills` and `deniedSkills` filter Skill names before run context
is assembled.

`includeLoaderTool` exposes progressive loading as a governed tool.
`loadSelectedSkills` controls whether matched Skill bodies are placed in
resident run context. The host defaults to on-demand loading
(`includeLoaderTool: true`, `loadSelectedSkills: false`): only a Skill index is
resident up front, and the model pulls bodies it judges relevant via
`skill_load`.

Set `loadSelectedSkills: true` only when you deliberately want matched Skill
bodies resident before the first model call.

## Agent Profiles

Workspace agent profiles can be managed through the project config file and
project convention directory:

```bash
sparkwright agents list --workspace .
sparkwright agents validate --workspace .
sparkwright agents create reviewer \
  --prompt "Inspect changes for correctness and risk." \
  --allow read_file \
  --allow glob_paths \
  --delegate delegate_reviewer \
  --workspace .
```

Markdown profiles are folded under `capabilities.agents.profiles`; if the same
id exists in `config.json`, the config entry wins. Advanced fields such as
policy and run budget should stay in `config.json`.

## Cost Metadata

Provider model entries can attach per-million-token pricing for usage reports:

```json
{
  "providers": {
    "openai": {
      "apiKey": "replace-me",
      "models": {
        "gpt-5.4-mini": {
          "cost": {
            "input": 1.25,
            "output": 10,
            "cacheRead": 0.1,
            "cacheWrite": 1.25
          }
        }
      }
    }
  }
}
```

Models not listed in `models` can still run; they simply lack attached cost
metadata.

## TUI Preferences

```json
{
  "theme": "dark",
  "mouse": true,
  "keybindings": {
    "palette.open": "ctrl+p",
    "help.open": "?",
    "cancel.run": "esc",
    "quit.app": "ctrl+c"
  }
}
```

`theme`, `mouse`, and `keybindings` are TUI-only. Provider, model, permission,
and workspace settings apply to both CLI and TUI surfaces.
`palette.open` and `quick.switch` are unbound by default; use `/palette` and
`/quick`, or add bindings here if you want direct shortcuts.

## Inspect And Troubleshoot

Use these commands before guessing:

```bash
sparkwright capabilities inspect --workspace . --format text
sparkwright tools list --format text
sparkwright agents validate --workspace .
sparkwright skills validate --workspace .
```

`capabilities inspect` is read-only. It summarizes the workspace, effective
tool filters, Skill roots and shadows, agent roots and shadows, MCP servers,
cron state paths, and command directories.

Common checks:

- If a provider model is unknown, confirm `model` uses `provider/model` form
  and that the provider key exists under `providers`.
- If an API key is ignored, check whether the matching environment variable is
  overriding config.
- If a tool disappeared, look for `tools.enabled` allowlists and
  `tools.disabled` filters.
- If a project setting does not combine with a user setting, remember that most
  fields other than `providers` are replaced wholesale.
- If an MCP server cannot start, verify `cwd`, command path, timeout, and
  whether `enabled` is false.

## Configuration And Agent Control

Treat configuration as a governed workspace resource. If an agent proposes to
modify configuration, hosts should route that change through the same workspace
write, policy, approval, artifact, and trace path used for source files.

Recommended rules:

- Provider keys and endpoint changes require explicit approval.
- Permission mode changes require explicit approval.
- Workspace root changes require explicit approval.
- Tool enable/disable/defer changes should be visible in trace.
- TUI-only cosmetic changes may be lower risk.
- Agent-generated config diffs should be stored as artifacts.

This keeps configuration changes inspectable and recoverable instead of turning
settings into invisible prompt state.

The historical design notes for this surface are archived in
[Project Config Surface](../archive/PROJECT_CONFIG_SURFACE.md).
