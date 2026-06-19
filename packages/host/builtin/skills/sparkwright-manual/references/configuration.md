# Configuration

Use this reference when the user asks how to configure SparkWright itself:
config files, provider setup, model selection, permissions, workspace
selection, tool loading, Skills, MCP, or project agent defaults.

## Choose The Right Layer

```txt
Personal config: ~/.config/sparkwright/config.yaml
  Use for private provider settings: model, providers, API keys, and personal
  TUI preferences. Existing config.json/config.yaml/config.yml files are loaded.

Project config: <workspace>/.sparkwright/config.yaml
  Use for team-safe runtime defaults: permissionMode, tools, workflow hooks,
  skills, MCP, agents, and project convention directories. Existing
  config.json/config.yaml/config.yml files are loaded.

Temporary overrides: SPARKWRIGHT_CONFIG, environment variables, CLI flags
  Use for one-off runs, CI jobs, or local experiments.
```

Never recommend putting provider API keys in project config. Keep credentials
in the user file or environment variables.

## Files And Precedence

The config schema is `schemas/config.schema.json`.

Config is loaded in this order, with later sources overriding earlier sources:

1. `~/.config/sparkwright/config.{json,yaml,yml}`
2. `<workspace>/.sparkwright/config.{json,yaml,yml}`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

Within the user or project layer, `config.json` wins over `config.yaml`, which
wins over `config.yml`; multiple files in one layer are reported as a conflict.

`providers` is merged by provider key. Most other fields are replaced by the
later source. `capabilities` is not deep-merged across files; keep related
project capability settings together when possible.

## Scaffold

```bash
npm exec sparkwright -- init
npm exec sparkwright -- init --project
```

Package installation does not write config files. The first interactive CLI or
TUI run points at the expected user and project config paths if no config
exists yet.

`init` scaffolds the personal provider config. `init --project` scaffolds a
committable project config plus `.sparkwright/skills`, `.sparkwright/agents`,
and `.sparkwright/command`. Both commands are non-destructive: they do not
overwrite existing config files. `init --project` may recreate missing
convention directories, but it must not replace existing Skills, agents,
commands, sessions, tasks, or config content.

Inspect effective host capabilities before guessing:

```bash
npm exec sparkwright -- config inspect --workspace . --format text
npm exec sparkwright -- config explain --workspace . --format text
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

### Provider Request Options

Use `providerOptions` for AI SDK request-level controls. Provider-level options
apply to every model on that provider; model-level options shallow-override the
matching provider namespace.

Keep them in the same personal provider entry as the provider's `apiKey` and
`baseURL`. A later config layer's `providers.openai` entry replaces the earlier
provider entry instead of inheriting its secrets.

OpenAI reasoning summaries:

```json
{
  "providers": {
    "openai": {
      "providerOptions": {
        "openai": {
          "reasoningEffort": "low",
          "reasoningSummary": "auto"
        }
      }
    }
  }
}
```

SparkWright forwards these options into `generateText` and `streamText`.
Visible reasoning text still depends on the model and provider gateway; some
OpenAI-compatible proxies omit reasoning summary deltas.

### Safe Project Defaults

```json
{
  "policy": {
    "permissionMode": "default",
    "write": {
      "maxFiles": 1,
      "maxDiffLines": 200,
      "allowDeletions": false
    }
  },
  "tools": {
    "defer": ["todo_write", "read_anchored_text", "edit_anchored_text"]
  },
  "capabilities": {
    "skills": {
      "includeLoaderTool": true,
      "loadSelectedSkills": false,
      "resourceFileLimit": 8
    },
    "mcp": {
      "startup": "lazy",
      "toolSchemaLoad": "defer",
      "servers": []
    }
  }
}
```

Standard tools are enabled by default. Use `tools.use` for broad selectors such
as `workspace.read`, `workspace.write`, `shell`, `skills`, `agents`, `cron`,
`mcp`, or `mcp:<server>`; use `tools.allowed` only for concrete tool names.
Use `tools.disabled` to close concrete tool names, and `tools.defer` only to
delay built-in tool schemas. MCP tools use `capabilities.mcp.toolSchemaLoad`;
do not configure them with wildcard tool names. Prefer `task(action=...)` for
task inspection/control and `apply_patch` for ordinary file writes.

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
      "startup": "lazy",
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

Configured MCP servers default to `startup: "lazy"`: normal host runs do not
connect to them until an MCP gateway tool is used. Set `startup: "prepare"` to
connect and list concrete tool names such as `mcp_<server>_<tool>` during
host-run startup, or `startup: "eager"` to prepare them and default schema
loading to eager. With `capabilities.mcp.toolSchemaLoad: "defer"`, prepared
concrete MCP tools are loaded through `tool_search select:<tool-name>` instead
of being sent in the initial provider tool list. Preparation emits
`mcp.server.prepared` with either the concrete tool map or a structured prepare
failure.

ACP `session/new` can also supply session-scoped `mcpServers`. SparkWright
merges them with configured MCP servers for that ACP session and applies the
same lazy startup and policy behavior. `http`, `sse`, and stdio server
descriptors are supported; MCP-over-ACP descriptors are rejected until that
transport exists.

### Workflow Hooks

Use `capabilities.hooks.workflow` for checked-in project rules: block
forbidden paths, inject project context, run tests after writes, or prevent
final answers until verification has happened. Lower-level `RunHook`,
`ValidationHook`, and `UserHookRunner` APIs are for SDK embedders and host
integrations, not the usual project config surface.

```json
{
  "capabilities": {
    "hooks": {
      "workflow": [
        {
          "name": "block-generated",
          "description": "Generated files are produced by build tooling.",
          "hook": "PreToolUse",
          "matcher": {
            "toolName": ["edit_anchored_text", "apply_patch"],
            "pathGlob": "src/generated/**",
            "excludePathGlob": "src/generated/fixtures/**"
          },
          "action": {
            "type": "block",
            "reason": "Generated files under src must not be edited directly."
          }
        },
        {
          "name": "test-after-write",
          "hook": "PostToolUse",
          "frequency": "oncePerTurn",
          "matcher": {
            "toolName": ["edit_anchored_text", "apply_patch"]
          },
          "action": {
            "type": "command",
            "command": "npm",
            "args": ["test"],
            "timeoutMs": 120000,
            "blockOnFailure": true,
            "injectOutput": "onFailure"
          }
        }
      ]
    }
  }
}
```

Command actions run without a shell. Set `stdin` to `json` when the command
needs the workflow hook input on stdin; omit it or use `none` for empty stdin.
Use `PostToolUse` for feedback after an action. Use `Stop` when the same rule
must gate the final answer.

## Common Fields

- `model`: active model in `provider/model` form. The reserved
  `deterministic` provider is built in.
- `providers`: named provider definitions. Keep API keys private.
- `permissionMode`: default run permission mode.
- `workspace`: default workspace root. Relative paths resolve from the config
  file that defines them.
- `tools`: preferred tool selector, allow/disable, and defer settings.
- `capabilities.hooks.workflow`: deterministic project workflow hooks.
- `capabilities.skills`: Skill roots and loading behavior.
- `capabilities.mcp`: MCP server definitions, default policy, and MCP tool
  schema loading.
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
npm exec sparkwright -- capabilities inspect --workspace . --format text
npm exec sparkwright -- tools allow <tool-name...>
npm exec sparkwright -- tools disable <tool-name...>
npm exec sparkwright -- tools defer <tool-name...>
```

Add `--workspace <path>` to manage project defaults in
`<workspace>/.sparkwright/config.{json,yaml,yml}` instead:

```bash
npm exec sparkwright -- capabilities inspect --workspace . --format text
npm exec sparkwright -- tools allow read_file --workspace .
npm exec sparkwright -- tools disable shell --workspace .
npm exec sparkwright -- tools defer todo_write --workspace .
```

`tools allow` appends concrete names to `tools.allowed`; edit `tools.use`
directly for selector scoping. Use `defer` for built-in tools that should be
discovered lazily instead of being loaded into the initial provider schema.
Configure MCP tool schema loading with `capabilities.mcp.toolSchemaLoad` and MCP
connection timing with `capabilities.mcp.startup`.

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
config entries win over markdown profiles. Agent profiles can use broad `use`
selectors and concrete `allowedTools`; both filters are applied. Set
`capabilities.agents.maxDepth` to cap nested child/delegate spawning. Only
`delegateTools` entries become callable tools.

Agent profiles may also describe an external ACP-compatible worker under
`metadata.acp`. When such a profile is exposed through `delegateTools`,
SparkWright creates an approval-gated tool that launches the configured command
over stdio and sends the delegated goal through ACP:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_reviewer",
          "metadata": {
            "acp": {
              "transport": "stdio",
              "command": "codex",
              "args": ["acp"],
              "workspaceAccess": "read_write",
              "timeoutMs": 120000
            }
          }
        }
      ],
      "delegateTools": [
        {
          "profileId": "external_reviewer",
          "toolName": "delegate_external_reviewer"
        }
      ]
    }
  }
}
```

`command` and `args` are local to the machine running the host. The ACP
delegate receives the project cwd and prompt content, while SparkWright keeps
policy, approval, trace, and the parent run lifecycle. ACP delegate `envMode`
defaults to `explicit`: the child gets a minimal process environment
(`PATH`/Windows process basics) plus configured `env`. Set `envMode:
"inherit"` only when the delegate needs the parent environment.

For local assistants that are exposed as normal CLI commands rather than ACP
servers, use `metadata.externalCommand`:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_cli_reviewer",
          "metadata": {
            "externalCommand": {
              "command": "agent-cli",
              "args": ["run", "{{goal}}"],
              "envMode": "inherit",
              "input": "none",
              "workspaceAccess": "read_write",
              "timeoutMs": 120000,
              "maxStdoutBytes": 64000,
              "maxStderrBytes": 64000
            }
          }
        }
      ],
      "delegateTools": [
        {
          "profileId": "external_cli_reviewer",
          "toolName": "delegate_external_cli_reviewer"
        }
      ]
    }
  }
}
```

External command delegates call `spawn` directly, not a shell. Supported
placeholders in `args` are `{{goal}}`, `{{metadataJson}}`, and
`{{workspaceRoot}}`. `input` may be `argument`, `stdin`, or `none`. Non-zero
exits fail the delegate unless listed in `successExitCodes`. `envMode` defaults
to `inherit`; use `explicit` to pass only the configured `env` map. Use
`maxStdoutBytes` and `maxStderrBytes` for independent output limits, or
`maxOutputBytes` as a shared fallback. `{{workspaceRoot}}` and `cwd` require
`"workspaceAccess": "read_write"`; without it, the external process runs away
from the project directory.

Debug configured external delegates directly with:

```bash
sparkwright delegates run delegate_external_cli_reviewer \
  --workspace . \
  --goal "Inspect README.md and return one concise suggestion." \
  --session-id delegate-debug \
  --trace-level debug \
  --yes
```

This command supports external ACP and external command delegates. Internal
SparkWright child-agent profiles still run through the normal model/tool loop.
It writes a normal session trace under
`.sparkwright/sessions/<session-id>/trace.jsonl`.
If the delegate profile uses `workspaceAccess: "read_write"`, direct debug runs
must also pass `--write`; otherwise SparkWright refuses to expose the project
workspace even when the delegate execution itself is approved.

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
npm exec sparkwright -- config path --workspace . --format text
npm exec sparkwright -- config validate --workspace . --format text
npm exec sparkwright -- config inspect --workspace . --format text
npm exec sparkwright -- config explain --workspace . --format text
npm exec sparkwright -- capabilities inspect --workspace . --format text
npm exec sparkwright -- capabilities inspect --workspace . --resolve-mcp --format text
npm exec sparkwright -- agents validate --workspace .
npm exec sparkwright -- skills validate --workspace .
```

`config validate` checks loaded JSON/YAML files against the shipped config
schema and the host loader's semantic rules. `config inspect` shows the
effective merged config with secret-looking fields redacted. `config explain`
shows field origins and values. `capabilities inspect` shows prepared runtime
surfaces such as tools, Skills, agents, MCP, cron, and command directories.

## Install And Upgrade Safety

SparkWright treats config and project capabilities as user-owned assets:

- package installation does not create or modify config files
- first interactive use suggests `init` paths instead of silently writing files
- `init` and `init --project` do not overwrite existing config files
- upgrade or reinstall must not overwrite existing Skills, agents, commands,
  sessions, tasks, or config
- commands that replace an existing user asset require explicit `--force` or a
  dedicated apply/approval flow
- future config migrations should be inspectable and preferably dry-run before
  writing

Checks to make before proposing edits:

- Unknown provider: confirm `model` uses `provider/model` form and the provider
  key exists under `providers`.
- API key ignored: check environment variable overrides.
- Tool missing: inspect `tools.use`, `tools.allowed`, `tools.disabled`,
  `tools.defer`, and MCP server `enabled` settings.
- MCP tool missing: use `capabilities inspect --resolve-mcp` to distinguish a
  configured server from a prepared server with resolved tools.
- User and project capability settings did not combine: remember that most
  fields other than `providers` are wholesale-overridden.
- MCP server does not start: verify `cwd`, command path, timeout, and
  `enabled`; run inspection with `--resolve-mcp` to reproduce the same concrete
  tool discovery path outside a model run.

## Agent-Written Config Changes

When an agent proposes config changes, route them through governed workspace
write behavior:

- provider key or endpoint changes require explicit approval
- permission mode changes require explicit approval
- workspace root changes require explicit approval
- tool enable/disable/defer changes should be visible in trace
- generated config diffs should be stored as artifacts where possible
