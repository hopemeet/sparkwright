# Configuration

Sparkwright configuration is user-editable JSON shared by the CLI and TUI.
The schema is [schemas/config.schema.json](../../schemas/config.schema.json).

## Load Order

Configuration is loaded in this order, with later sources overriding earlier
ones:

1. `~/.config/sparkwright/config.json`
2. `<workspace>/.sparkwright/config.json`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

The `providers` map is merged by provider key. Most other fields are replaced
wholesale by the later source.

## Project Config Surface

`<workspace>/.sparkwright/config.json` is meant to **travel with the
repository**. Only runtime state under `.sparkwright/` (`sessions/`, `runs/`,
`tui-history.jsonl`, `tui-stash.json`) is gitignored; the config file and the
`command/` + `agents/` convention directories are committable.

Scaffold the two layers separately:

```bash
sparkwright init             # ~/.config/sparkwright/config.json (holds secrets, chmod 600)
sparkwright init --project   # <workspace>/.sparkwright/config.json (no secrets, safe to commit)
```

Keep provider API keys in the user-level file; the project template carries
none. The config schema permits a top-level `"$schema"` (which the loader
ignores) so editors can offer completion and validation, but the scaffolds do
**not** emit one yet — pointing at an unhosted schema URL would only make editors
fail to fetch it. Add `"$schema"` yourself once the schema is published.

Precedence, weak to strong:

```txt
convention markdown files < user config < project config < $SPARKWRIGHT_CONFIG / CLI
```

That means markdown files are a team-default convenience layer, while
`config.json` remains the precise-control layer.

The historical design notes for this surface are archived in
[Project Config Surface](../archive/PROJECT_CONFIG_SURFACE.md).

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
model: deterministic/demo
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

## Markdown Agent Profiles

Project agent profiles can be committed as markdown files under:

```txt
<workspace>/.sparkwright/agents/<id>.md
```

The filename is the profile id. Frontmatter covers the common fields; the body
becomes the profile prompt:

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

Markdown profiles are folded under `capabilities.agents.profiles`; if the same
id exists in `config.json`, the config entry wins. Advanced fields such as
policy and run budget should stay in `config.json`.

Profiles describe role guidance and constraints. They do not grant authority by
themselves. Only entries listed in `capabilities.agents.delegateTools` become
callable parent-run tools, and those tools still go through policy, approval,
validation, and trace.

## Minimal Config

```json
{
  "model": "deterministic/demo",
  "permissionMode": "default",
  "workspace": "."
}
```

The reserved `deterministic` provider is built in and does not need a
`providers` entry.

## OpenAI-Compatible Provider

```json
{
  "model": "openai/gpt-example",
  "providers": {
    "openai": {
      "npm": "@ai-sdk/openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "replace-me"
    }
  }
}
```

`OPENAI_API_KEY` overrides provider `apiKey` when set. `OPENAI_BASE_URL`
overrides provider `baseURL` when set.

Store config files containing API keys privately. The schema currently stores
provider keys as plaintext.

## Model Cost Metadata

Provider model entries can attach per-million-token pricing for usage reports:

```json
{
  "providers": {
    "openai": {
      "apiKey": "replace-me",
      "models": {
        "gpt-example": {
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
    "palette.open": "ctrl+k",
    "help.open": "?",
    "cancel.run": "esc",
    "quit.app": "ctrl+c"
  }
}
```

`theme`, `mouse`, and `keybindings` are TUI-only. Provider, model, permission,
and workspace settings apply to both CLI and TUI surfaces.

## Capability Runtime

`capabilities` is owned by the host runtime. The TUI may show a read-only
snapshot through `/capabilities`, but it does not scan Skill directories, open
MCP connections, or derive agent profiles itself.

```json
{
  "capabilities": {
    "tools": {
      "enabled": ["read_file", "glob_paths", "mcp_*"],
      "disabled": ["shell"],
      "defer": ["mcp_*"]
    },
    "skills": {
      "roots": ["./skills"],
      "includeLoaderTool": true,
      "loadSelectedSkills": true,
      "maxSelectedSkills": 4,
      "resourceFileLimit": 8,
      "allowedSkills": ["code-reviewer"],
      "deniedSkills": ["unsafe-local-admin"]
    },
    "mcp": {
      "servers": [
        {
          "type": "stdio",
          "name": "workspace",
          "command": "node",
          "args": ["./tools/workspace-mcp.js"],
          "cwd": ".",
          "enabled": false
        }
      ],
      "defaultTimeoutMs": 30000,
      "namePrefix": "mcp",
      "defaultPolicy": {
        "risk": "risky",
        "requiresApproval": true
      }
    },
    "agents": {
      "profiles": [
        {
          "id": "primary",
          "name": "Primary",
          "mode": "primary",
          "prompt": "Coordinate the run and call delegate tools only when useful."
        },
        {
          "id": "reviewer",
          "name": "Reviewer",
          "mode": "child",
          "prompt": "Inspect changes for correctness, risk, and missing tests.",
          "allowedTools": ["read_file", "glob_paths"],
          "maxSteps": 4
        }
      ],
      "delegateTools": [
        {
          "profileId": "reviewer",
          "toolName": "delegate_reviewer",
          "requiresApproval": true,
          "forbidNesting": true,
          "maxSteps": 4
        }
      ]
    }
  }
}
```

`tools.enabled`, `tools.disabled`, and `tools.defer` accept tool names or `*`
wildcard patterns. `enabled` is an optional allowlist; when omitted, host
assembly starts from all available tools. `disabled` removes matching tools.
`defer` keeps matching tools discoverable while delaying their full schemas when
the tool does not force eager loading. These settings only decide which tools
the host prepares before a run. Tool execution still goes through policy,
approval, validation, and trace.

The CLI can manage the user-level tool settings in
`~/.config/sparkwright/config.json`:

```bash
sparkwright tools list --format text
sparkwright tools enable read_file glob_paths
sparkwright tools disable shell
sparkwright tools defer "mcp_*"
```

Workspace agent profiles can be managed through the project config file
`<workspace>/.sparkwright/config.json`:

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

Skill roots and MCP `cwd` values resolve from the config file that declares
them. `allowedSkills` and `deniedSkills` filter Skill names before run context
is assembled. `includeLoaderTool` exposes progressive loading as a governed
tool; `loadSelectedSkills` controls whether matched Skill bodies are placed in
resident run context. The host defaults to **on-demand** loading
(`includeLoaderTool: true`, `loadSelectedSkills: false`): only a Skill index is
resident up front, and the model pulls bodies it judges relevant via `skill.load`.
Set `loadSelectedSkills: true` to opt into auto-resident matched-Skill bodies.

MCP servers are prepared by the host when a run starts. Disabled servers remain
inspectable but are not connected. Use `defaultPolicy` for tools that do not
declare stricter policy metadata, and prefer `requiresApproval: true` for tools
that can touch workspace state, credentials, network services, or external
systems.

Agent profiles are descriptions and constraints, not authority by themselves.
Only entries listed in `delegateTools` become callable parent-run tools. Delegate
tools are intentionally explicit so a profile can be inspectable without
granting the model a new execution path.

## Configuration And Agent Control

Treat configuration as a governed workspace resource. If an agent proposes to
modify configuration, hosts should route that change through the same workspace
write, policy, approval, artifact, and trace path used for source files.

Recommended rules:

- Provider keys and endpoint changes require explicit approval.
- Permission mode changes require explicit approval.
- Workspace root changes require explicit approval.
- TUI-only cosmetic changes may be lower risk.
- Agent-generated config diffs should be stored as artifacts.

This keeps configuration changes inspectable and recoverable instead of turning
settings into invisible prompt state.
