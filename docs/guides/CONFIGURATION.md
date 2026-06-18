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

The `providers` map is merged by provider key. The security boundaries —
`permissionMode`, `confidentialPaths`, `write`, and `shell.sandbox` — merge
conservatively, so a later (lower-trust) layer can only tighten them, never
weaken them. Most other fields are replaced wholesale by the later source. In
particular, `capabilities` is not deep-merged across files; put related project
capability settings in the same project config file when possible.

Precedence, weak to strong:

```txt
convention markdown files < user config < project config < $SPARKWRIGHT_CONFIG / CLI
```

That means markdown files are a team-default convenience layer, while
`config.json` remains the precise-control layer.

## Scaffold

Installing Sparkwright does not write config files. The first interactive CLI
or TUI run prints the user and project config paths if no config exists yet.
Create files only when you choose to scaffold them:

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

Both init commands are non-destructive: they refuse to overwrite an existing
config file. `init --project` may recreate missing convention directories, but
it does not replace existing Skills, agents, commands, sessions, tasks, or
config content.

Inspect what the host will actually prepare:

```bash
sparkwright config inspect --workspace . --format text
sparkwright config explain --workspace . --format text
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

### Provider Request Options

Use `providerOptions` when an AI SDK provider exposes request-level controls
that SparkWright does not model directly. Provider-level options apply to every
model under that provider; model-level options shallow-override the matching
provider namespace.

Keep these options in the same personal provider entry as the provider's
`apiKey`/`baseURL`. Across config layers, a later `providers.openai` entry
replaces the earlier provider entry rather than inheriting its secrets.

For OpenAI reasoning summaries:

```json
{
  "model": "openai/gpt-5.4-mini",
  "providers": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "replace-me",
      "providerOptions": {
        "openai": {
          "reasoningEffort": "low",
          "reasoningSummary": "auto"
        }
      },
      "models": {
        "gpt-5.4-mini": {}
      }
    }
  }
}
```

SparkWright forwards these options to `generateText` and `streamText`. Whether
reasoning text appears depends on the selected model and provider gateway; some
OpenAI-compatible proxies may accept the request but omit visible reasoning
summary deltas.

### Safe Project Defaults

Put project-wide behavior in `<workspace>/.sparkwright/config.json`:

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

Standard tools are enabled by default. `tools.disabled` is the only project
setting that closes tools; `tools.defer` only delays provider schema loading for
the listed built-in tools. MCP tools use `capabilities.mcp.toolSchemaLoad`
instead of wildcard tool names. The `write` block caps a run to a single file
with no line deletions; raise `maxFiles`/`maxDiffLines` or set
`allowDeletions: true` for projects that expect broader edits. Because `write`
merges conservatively, a personal config can tighten these further but a
project config cannot loosen a stricter personal setting.

### Shell Sandbox

The built-in `shell` tool still goes through command classification, policy,
approval, and workspace mutation audit. `shell.sandbox` adds an experimental
OS-level process boundary underneath that flow. The same setting is also used
for configured workflow-hook commands, external-command delegates, and local
stdio MCP servers:

```json
{
  "shell": {
    "sandbox": {
      "mode": "warn",
      "filesystem": {
        "allowRead": ["."],
        "allowWrite": ["."],
        "denyRead": [".env", ".ssh", ".aws"],
        "denyWrite": [".sparkwright/config.json"],
        "tmp": true
      },
      "network": {
        "mode": "deny"
      }
    }
  }
}
```

Modes:

- `off`: run through the legacy unsandboxed process executors.
- `warn`: use the platform sandbox when available; otherwise fall back and mark
  supported command result metadata with the unavailable runtime.
- `enforce`: fail supported local process execution when the platform sandbox
  runtime is missing.

Linux uses `bubblewrap` (`bwrap`) for bind-based filesystem isolation. macOS
uses `sandbox-exec` for deny-list and network controls in this first adapter;
it protects forced deny paths such as Sparkwright config state but is not yet a
complete allow-list filesystem sandbox. Other platforms are unsupported in
enforce mode. The host always appends forced deny-write paths for Sparkwright
config and capability state so project config cannot remove those protections.
`sparkwright capabilities inspect` reports this distinction as
`fs=bind-allowlist` on Linux and `fs=deny-list-guard` on macOS. Treat the macOS
mode as a guard for configured deny paths and network access, not as evidence
that every unlisted filesystem path is hidden.
Across user, project, and explicit config files, `shell.sandbox` is merged
conservatively: stricter modes, `failIfUnavailable: true`, network deny,
filesystem deny paths, and `tmp: false` win over later weaker settings.

### Add Workflow Hooks

Project hooks live under `capabilities.hooks.workflow`. They attach
deterministic actions to the run lifecycle without relying on the model to
remember a rule.

Use workflow hooks for checked-in project rules: block forbidden paths, inject
project context, run tests after writes, or prevent final answers until required
verification has happened. Lower-level `RunHook`, `ValidationHook`, and
`UserHookRunner` APIs remain available for SDK embedders and host integrations,
but they are not the recommended project configuration surface.

Block generated files before a write tool runs:

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
        }
      ]
    }
  }
}
```

Inject a project rule at session start:

```json
{
  "capabilities": {
    "hooks": {
      "workflow": [
        {
          "name": "testing-rule",
          "hook": "SessionStart",
          "action": {
            "type": "context",
            "contextType": "system",
            "content": "Before final answer, mention which tests were run or state that tests were not run."
          }
        }
      ]
    }
  }
}
```

Run a command after workspace writes and feed the result back into the run:

```json
{
  "capabilities": {
    "hooks": {
      "workflow": [
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

Command actions use `command` plus `args`; user arguments are not shell-expanded
by the config surface. Relative `cwd` values resolve from the workspace root.
Command stdout and stderr are truncated before they are stored. Set
`injectOutput` to `always`, `onFailure`, or `never` to control whether command
output is added as workflow-hook context. Set `stdin` to `json` when the command
should receive the workflow hook input on stdin (`hook`, `run`, `step`,
`payload`, and `metadata`); omit it or set `none` for the default empty stdin.
Set `frequency` to `oncePerTurn` when a hook should run at most once for the
same run step. Command hooks use the same `shell.sandbox` process boundary as
the built-in shell tool.

`PostToolUse` command failures are fed back into the run so the model can
correct course. Pair a post-tool check with a `Stop` hook when a condition must
also be enforced before the final answer.

### Add Verification Profiles

Use `capabilities.verification` when the project wants checked-in quality gates
without hand-writing workflow hooks. Verification commands run through the
project toolchain exactly as configured; Sparkwright does not install missing
linters, typecheckers, or package dependencies.

```json
{
  "capabilities": {
    "verification": {
      "mode": "require",
      "defaultProfile": "fast",
      "profiles": {
        "fast": [
          {
            "id": "lint",
            "kind": "lint",
            "command": "npm",
            "args": ["run", "lint"],
            "timeoutMs": 120000
          },
          {
            "id": "typecheck",
            "kind": "typecheck",
            "command": "npm",
            "args": ["run", "typecheck"],
            "timeoutMs": 180000
          }
        ],
        "full": [
          {
            "id": "check",
            "kind": "check",
            "command": "npm",
            "args": ["run", "check"],
            "timeoutMs": 600000
          }
        ]
      },
      "afterWrites": {
        "profile": "fast",
        "frequency": "always",
        "injectOutput": "onFailure"
      },
      "stopGate": {
        "enabled": true,
        "requireCleanAfterLastWrite": true
      }
    }
  }
}
```

Modes:

- `off`: disable verification hooks.
- `suggest`: inject the configured profile as guidance, but let the model
  choose when to run commands. This is the default when `mode` is omitted.
- `require`: run the selected profile after write-tool calls and block final
  answers until every command has passed after the latest workspace write.

Prefer project commands such as `npm run lint`, `uv run ruff check .`, or
`cargo clippy` over bare global tools. That keeps verification aligned with CI
and avoids depending on whatever happens to be installed in the user's shell.

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
      "startup": "lazy",
      "defaultPolicy": {
        "risk": "risky",
        "requiresApproval": true
      }
    }
  }
}
```

MCP `cwd` resolves from the config file that declares it. Stdio MCP servers use
the same `shell.sandbox` process boundary as the built-in shell tool; HTTP and
SSE MCP servers are remote transports and are governed by MCP policy rather
than local process sandboxing. Prefer `requiresApproval: true` for tools that
can touch workspace state, credentials, network services, or external systems.

Configured MCP servers default to `startup: "lazy"`: a normal run records the
server as configured but does not connect to it until an MCP gateway tool is
used. Set `startup: "prepare"` when you want host-run startup to connect and
list concrete tool names such as `mcp_<server>_<tool>` for
`tool_search select:<tool-name>`. Set `startup: "eager"` when you also want
provider schemas loaded eagerly by default. The trace records
`mcp.server.prepared` only when a server is actually prepared, either by an MCP
gateway tool, startup prepare/eager, or `capabilities inspect --resolve-mcp`.
Use `capabilities inspect --resolve-mcp` when you explicitly want inspection to
connect to MCP servers and list concrete MCP tools.

ACP clients may also pass session-scoped MCP servers in `session/new`
`mcpServers`. SparkWright merges those servers with configured project/user MCP
servers for that ACP session and applies the same prepare, deferred-schema, and
policy path.
ACP `http`, `sse`, and stdio server descriptors are supported. ACP-over-ACP MCP
transport descriptors are rejected with `invalidParams` until that transport is
implemented.

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
allowedTools: [read_file, glob]
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
- `permissionMode`: default run permission mode. Merges conservatively across
  layers — a later layer can only tighten, never escalate, the mode.
- `workspace`: default workspace root. Relative paths resolve from the config
  file that defines them.
- `confidentialPaths`: opt-in read-confidentiality globs. Unions across layers
  (a later layer can only add entries, never drop them).
- `write`: workspace write guardrails (`maxFiles`, `maxDiffLines`,
  `allowDeletions`) that override the runtime defaults. Merges conservatively —
  the smaller `maxFiles`/`maxDiffLines` wins and `allowDeletions: false` wins.
- `shell.sandbox`: OS-level sandbox for the host shell executor. Merges
  conservatively so a later layer cannot weaken an earlier sandbox policy.
- `runBudget`: resource budget for the interactive main run (`maxModelCalls`,
  `maxToolCalls`, `maxDurationMs`, `maxTokens`, `maxCostUsd`). `maxModelCalls`
  is the tightest natural step bound. An explicit main agent profile under
  `capabilities.agents` overrides this.
- `maxSteps`: explicit main-run step ceiling. Overrides the value derived from
  `runBudget` and the safety backstop.
- `traceLevel`: default trace verbosity (`standard`, `debug`) when an
  entrypoint does not pass one. CLI `--trace-level` overrides.
- `approvals`: default approval auto-grants (`shellSafe`, `edits`, `all`). CLI
  flags (`--yes`, `--yes-edits`, `--yes-shell-safe`) still override.
- `tools`: preferred tool disable/defer settings.
- `capabilities.skills`: Skill roots and loading behavior.
- `capabilities.mcp`: MCP server definitions, default policy, and MCP tool
  schema loading.
- `capabilities.agents`: agent profiles and delegate tools.
- `theme`, `mouse`, `keybindings`: TUI-only preferences.

Child agents and delegate tools do not weaken the parent run. Spawned child
agents inherit the parent run's permission mode, write guardrails, target path,
and confidential read scope before their own agent-profile policy is layered on
top. This means a reviewer or dynamically spawned child cannot read paths the
parent run marks confidential or write outside the parent run's write boundary.

### Grouped Form

Fields may be written flat (as above) or under the preferred groups, which make
the layering intent obvious:

```json
{
  "identity": { "model": "openai/gpt-x", "providers": { "openai": {} } },
  "policy": {
    "permissionMode": "default",
    "confidentialPaths": ["secrets/**"],
    "write": { "maxFiles": 1 },
    "sandbox": { "mode": "warn" }
  },
  "run": {
    "budget": { "maxModelCalls": 50 },
    "traceLevel": "standard",
    "approvals": { "shellSafe": true }
  },
  "ui": { "theme": "dark" }
}
```

- `identity` → `model`, `providers` (belongs in the user config).
- `policy` → `permissionMode`, `confidentialPaths`, `write`, and `sandbox`
  (maps to `shell.sandbox`) — the conservatively-merged security boundaries.
- `run` → `runBudget` (as `budget`), `maxSteps`, `traceLevel`, `approvals`.
- `ui` → `theme`, `mouse`, `keybindings`.
- `capabilities` is already its own group.

The flat and grouped forms are equivalent; `sparkwright init` now emits the
grouped form. Setting the same field both ways is an error — the grouped value
wins and a warning is reported.

### Editor autocomplete and validation

A full JSON Schema ships at `schemas/config.schema.json`. Wire it to your editor
to get completion, hovers, and validation while authoring config — no hosted URL
required. In VS Code, add a `json.schemas` mapping to your workspace or user
settings (`.vscode/` is gitignored here, so this stays a personal setting):

```jsonc
// .vscode/settings.json
{
  "json.schemas": [
    {
      "fileMatch": ["**/.sparkwright/config.json", "sparkwright/config.json"],
      "url": "./schemas/config.schema.json",
    },
  ],
}
```

Downstream projects can point `url` at the shipped copy under `node_modules`.
The schema also permits a top-level `"$schema"` key if you prefer to reference a
copy directly; the scaffolds do not emit one.

## Permission Modes

- `plan`: prefer read-only planning.
- `default`: normal approval behavior for risky actions.
- `accept_edits`: accept workspace edits while preserving other policy gates.
- `dont_ask`: avoid interactive approval prompts where the host permits it.
- `bypass_permissions`: trusted-host escape hatch.

Deny rules should remain authoritative. Skills, MCP servers, and agent profiles
do not grant authority by themselves.

## Tool Filters

Top-level `tools` is the preferred tool configuration surface.

- `disabled`: concrete tool names removed from the prepared run tool set.
- `defer`: concrete built-in tool names kept available but omitted from the
  initial provider tool schema until discovered through `tool_search`.

When `defer` is omitted, SparkWright applies a small default defer list for
low-frequency tools (`todo_write`, `read_anchored_text`,
`edit_anchored_text`). Use an explicit empty list (`"defer": []`) to disable
that default. `tools.disabled` and `tools.defer` accept only concrete tool
names (no wildcards); inspect available names before editing. The legacy
`capabilities.tools` surface (including its `enabled` allowlist and wildcard
patterns) has been removed — move any such config to top-level `tools`.

MCP server tools are controlled under `capabilities.mcp`:

```json
{
  "capabilities": {
    "mcp": {
      "startup": "lazy",
      "toolSchemaLoad": "defer",
      "servers": []
    }
  }
}
```

Set `startup: "prepare"` to connect to MCP servers at run startup, or
`startup: "eager"` to prepare them and default schema loading to eager. Set a
server's own `toolSchemaLoad` to override the MCP default for that server.

These settings only decide which tools the host prepares before a run. Tool
execution still goes through policy, approval, validation, and trace.

The CLI can manage user-level tool settings in
`~/.config/sparkwright/config.json`:

```bash
sparkwright tools disable shell
sparkwright tools defer todo_write
```

Add `--workspace <path>` to manage project defaults in
`<workspace>/.sparkwright/config.json` instead:

```bash
sparkwright tools disable shell --workspace .
sparkwright tools defer todo_write --workspace .
```

Use `sparkwright capabilities inspect --workspace . --format text` for the
runtime tool inventory.

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
  --allow glob \
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
`/quick` (the quick mode of `/sessions`), or add bindings here if you want
direct shortcuts.

## Inspect And Troubleshoot

Use these commands before guessing:

```bash
sparkwright config path --workspace .         # which files load, in order
sparkwright config validate --workspace .      # report schema/load problems
sparkwright config inspect --workspace .       # effective config, redacted
sparkwright config explain --workspace .       # field origins and values
sparkwright config example hooks               # paste-ready grouped snippet
sparkwright capabilities inspect --workspace . --format text
sparkwright agents validate --workspace .
sparkwright skills validate --workspace .
```

`config path` lists the resolution order and whether each layer loaded.
`config validate` loads the merged config and prints any field problems,
exiting non-zero when there are errors. `config inspect` prints the effective
merged config with secret-looking fields redacted. `config explain` focuses on
where each resolved field came from. `config example <name>` prints a
copy-pasteable snippet in the grouped form (names: `write`, `sandbox`, `run`,
`hooks`, `verification`, `mcp`, `agent`). `capabilities inspect` is read-only.
It summarizes the workspace, effective tool filters, Skill roots and shadows,
agent roots and shadows, MCP servers, cron state paths, and command
directories. `doctor paths` prints the installation, config, capability, user
state, and workspace state paths without starting a run.

## Install And Upgrade Safety

Sparkwright treats config and project capabilities as user-owned assets:

- Package installation does not create or modify config files.
- First interactive use points at the expected config paths and suggests
  `sparkwright init` or `sparkwright init --project`.
- `init` and `init --project` do not overwrite existing config files.
- Project upgrade or reinstall must not overwrite existing Skills, agents,
  commands, sessions, tasks, or config.
- Commands that can replace an existing user asset require an explicit
  `--force` or a dedicated apply/approval flow.
- User-level runtime state belongs under `~/.local/state/sparkwright`; program
  installation may use `~/.sparkwright`, but package install and upgrade should
  not place config, credentials, sessions, or gateway state there.
- Future config migrations should be inspectable and preferably dry-run before
  writing.

## Common Troubleshooting Checks

- If a provider model is unknown, confirm `model` uses `provider/model` form
  and that the provider key exists under `providers`.
- If an API key is ignored, check whether the matching environment variable is
  overriding config.
- If a tool disappeared, look for `tools.disabled`, legacy allowlists, and MCP
  server `enabled` settings.
- If a project setting does not combine with a user setting, remember that most
  fields other than `providers` are replaced wholesale — except the security
  boundaries (`permissionMode`, `confidentialPaths`, `write`, `shell.sandbox`),
  which merge conservatively and cannot be weakened by a later layer.
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
