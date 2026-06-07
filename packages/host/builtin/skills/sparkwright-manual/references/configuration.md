# Configuration

Use this reference when the user asks how to configure SparkWright itself:
config files, provider setup, model selection, permissions, workspace
selection, tool loading, Skills, MCP, or project agent defaults.

## Choose The Right Layer

```txt
Personal config: ~/.config/sparkwright/config.json
  Use for private provider settings: model, providers, API keys, and personal
  TUI preferences.

Project config: <workspace>/.sparkwright/config.json
  Use for team-safe runtime defaults: permissionMode, tools, skills, MCP,
  agents, and project convention directories.

Temporary overrides: SPARKWRIGHT_CONFIG, environment variables, CLI flags
  Use for one-off runs, CI jobs, or local experiments.
```

Never recommend putting provider API keys in project config. Keep credentials
in the user file or environment variables.

## Files And Precedence

The config schema is `schemas/config.schema.json`.

Config is loaded in this order, with later sources overriding earlier sources:

1. `~/.config/sparkwright/config.json`
2. `<workspace>/.sparkwright/config.json`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

`providers` is merged by provider key. Most other fields are replaced by the
later source. `capabilities` is not deep-merged across files; keep related
project capability settings together when possible.

## Scaffold

```bash
npm exec sparkwright -- init
npm exec sparkwright -- init --project
```

`init` scaffolds the personal provider config. `init --project` scaffolds a
committable project config plus `.sparkwright/skills`, `.sparkwright/agents`,
and `.sparkwright/command`.

Inspect effective host capabilities before guessing:

```bash
npm exec sparkwright -- capabilities inspect --workspace . --format text
```

## Quick Recipes

### Offline Smoke Test

```json
{
  "model": "deterministic",
  "permissionMode": "default",
  "workspace": "."
}
```

The reserved `deterministic` provider is built in and does not need a
`providers` entry.

### Personal Provider

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

`OPENAI_API_KEY` overrides provider `apiKey`. `OPENAI_BASE_URL` overrides
provider `baseURL`. Proxy variables `HTTPS_PROXY`, `https_proxy`,
`HTTP_PROXY`, and `http_proxy` are passed to the OpenAI-compatible provider
path by the CLI.

Store files containing provider keys privately. Keys are plaintext in config.

### Safe Project Defaults

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

Do not add `tools.enabled` unless the user explicitly wants an allowlist.
Omitting it lets the host start from all available tools before applying
`disabled` and `defer`.

### Stdio MCP Server

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

## Common Fields

- `model`: active model in `provider/model` form. The reserved
  `deterministic` provider is built in.
- `providers`: named provider definitions. Keep API keys private.
- `permissionMode`: default run permission mode.
- `workspace`: default workspace root. Relative paths resolve from the config
  file that defines them.
- `capabilities.tools`: tool enable, disable, and defer filters.
- `capabilities.skills`: Skill roots and loading behavior.
- `capabilities.mcp`: MCP server definitions and default policy.
- `capabilities.agents`: agent profiles and delegate tools.
- `theme`, `mouse`, `keybindings`: TUI-only preferences.

## Permission Modes

- `plan`: prefer read-only planning.
- `default`: normal approval behavior for risky actions.
- `accept_edits`: accept workspace edits while preserving other policy gates.
- `dont_ask`: avoid interactive approval prompts where the host permits it.
- `bypass_permissions`: trusted-host escape hatch.

Deny rules should remain authoritative. Skills, MCP servers, and agent profiles
do not grant authority by themselves.

## Tools Config

The CLI can update user-level tool loading settings:

```bash
npm exec sparkwright -- tools list --format text
npm exec sparkwright -- tools enable <pattern...>
npm exec sparkwright -- tools disable <pattern...>
npm exec sparkwright -- tools defer <pattern...>
```

Use `defer` for tools that should be discovered lazily instead of being loaded
into the initial prompt.

## Skills And Agents

The host default is on-demand Skill loading:

```json
{
  "capabilities": {
    "skills": {
      "includeLoaderTool": true,
      "loadSelectedSkills": false
    }
  }
}
```

That keeps only the Skill index resident up front and lets the model pull
relevant bodies through `skill_load`. Set `loadSelectedSkills: true` only when
the user deliberately wants matched Skill bodies in resident context.

Project agent profiles can live under `.sparkwright/agents/<id>.md`.
Config-defined profiles live under `capabilities.agents.profiles`, and matching
config entries win over markdown profiles. Only `delegateTools` entries become
callable tools.

## Cost Metadata

Per-model cost metadata is optional and used for usage/cost reporting:

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

Models not listed still run if the provider accepts them.

## Troubleshooting

Use local facts first:

```bash
npm exec sparkwright -- capabilities inspect --workspace . --format text
npm exec sparkwright -- tools list --format text
npm exec sparkwright -- agents validate --workspace .
npm exec sparkwright -- skills validate --workspace .
```

Checks to make before proposing edits:

- Unknown provider: confirm `model` uses `provider/model` form and the provider
  key exists under `providers`.
- API key ignored: check environment variable overrides.
- Tool missing: inspect `tools.enabled` allowlists and `tools.disabled`.
- User and project capability settings did not combine: remember that most
  fields other than `providers` are wholesale-overridden.
- MCP server does not start: verify `cwd`, command path, timeout, and
  `enabled`.

## Agent-Written Config Changes

When an agent proposes config changes, route them through governed workspace
write behavior:

- provider key or endpoint changes require explicit approval
- permission mode changes require explicit approval
- workspace root changes require explicit approval
- tool enable/disable/defer changes should be visible in trace
- generated config diffs should be stored as artifacts where possible
