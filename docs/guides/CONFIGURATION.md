# Configuration

SparkWright configuration is user-editable JSON or YAML shared by the CLI,
TUI, and host runtime. The schema is
[schemas/config.schema.json](../../schemas/config.schema.json).

Use this guide in two passes: first choose the right configuration layer, then
copy the smallest recipe that matches the job. The full schema exists for
editors and validation, but most users should not need to understand every
field before running SparkWright.

## Choose The Right Layer

```txt
Personal config: ~/.config/sparkwright/config.yaml
  Put model defaults, custom provider endpoints/options, and personal TUI
  preferences here. Legacy API-key fields remain supported, but the preferred
  path is `provider connect` or TUI `/connect`.
  Existing config.json/config.yaml/config.yml files are also loaded.

Project config: <workspace>/.sparkwright/config.yaml
  Put team-safe runtime defaults here: run.accessMode, tools, skills, MCP,
  agents. This file is safe to commit when it does not contain secrets.
  Existing config.json/config.yaml/config.yml files are also loaded.

Temporary overrides: SPARKWRIGHT_CONFIG, environment variables, CLI flags
  Use these for one-off runs, CI jobs, or local experiments.
```

Do not put provider API keys in project config. Prefer the Host credential
store; user-config and environment keys remain compatibility sources.

Project capability sources have an additional admission boundary. A project
config that can select runtime/model/process/network behavior and project
`.sparkwright/command`, `skills`, `agents`, or `workflows` files are inactive
until their exact content manifest is trusted. Safety-tightening fields such as
lower access/background ceilings, confidential paths, write limits, sandbox
enforcement/deny rules, restrictive tool selectors, hardened web transport,
and local UI preferences remain effective before trust.

Use `sparkwright trust status --workspace .` to inspect the five independent
scopes, `trust grant` after reviewing them, and `trust revoke` to remove the
pin. A content change invalidates only the affected scope. State is stored at
`$XDG_STATE_HOME/sparkwright/project-trust.json` (normally
`~/.local/state/sparkwright/project-trust.json`) with mode `0600`; it contains
canonical workspace identity, hashes, and timestamps, not capability bodies or
provider secrets. Trust admits source into existing governance and does not
weaken access, approval, sandbox, confidentiality, tool, or write policy.

## Where Files Live

SparkWright keeps installation, configuration, state, and project artifacts in
separate locations:

| What                                       | Default path                 | Notes                                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program install                            | `~/.sparkwright`             | Used by source installs for `versions/`, `current`, and `bin/sparkwright`.                                                                                                                         |
| User config and user-authored capabilities | `~/.config/sparkwright`      | Personal `config.{json,yaml,yml}`, user Skills, agents, and commands.                                                                                                                              |
| User runtime state                         | `~/.local/state/sparkwright` | Project trust pins, non-secret provider connection/catalog metadata, TUI model favorites/recent usage, cron jobs/output, IM gateway routing state, host crash logs, and other machine-local state. |
| Project data                               | `<workspace>/.sparkwright`   | Project config, project Skills/agents/commands, sessions, tasks, and exports.                                                                                                                      |

`~/.sparkwright` is not a config or state directory. Treat it as replaceable
program files owned by source install and uninstall scripts.

## Load Order

Configuration is loaded in this order, with later sources overriding earlier
ones:

1. `~/.config/sparkwright/config.{json,yaml,yml}`
2. `<workspace>/.sparkwright/config.{json,yaml,yml}`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

Within the user or project layer, SparkWright loads the first existing file in
this order: `config.json`, `config.yaml`, then `config.yml`. If multiple files
exist in the same layer, the first one still wins and validation reports a
same-layer conflict so the duplicate can be removed deliberately.

The `identity.providers` map is merged by provider key. The security boundaries —
`run.accessMode`, `policy.confidentialPaths`, `policy.write`, and
`policy.sandbox` — merge
conservatively. Project `run.accessMode` is the workspace access ceiling, and
requests above it are clamped; the other boundaries cannot be weakened by a
later layer. `policy.confidentialDefaults` is the explicit override for whether the
built-in confidential path set is active. Most other fields are replaced
wholesale by the later source. In particular, `capabilities` is not deep-merged
across files; put related project capability settings in the same project config
file when possible.

Precedence, weak to strong:

```txt
convention markdown files < user config < project config < $SPARKWRIGHT_CONFIG / CLI
```

That means markdown files are a team-default convenience layer, while config
files remain the precise-control layer.

## Scaffold

Installing SparkWright does not write config files. The TUI can start with no
config and use `/connect`. A first interactive CLI model run scaffolds the user
config if none exists, then points to `provider connect`; provider-management
commands themselves do not require scaffolding. You can also create files
explicitly:

Scaffold the two common layers separately:

```bash
sparkwright init             # ~/.config/sparkwright/config.yaml
sparkwright init --project   # <workspace>/.sparkwright/config.yaml
```

`sparkwright init` creates the same personal config template used by first-run
scaffolding. Connect through `sparkwright provider connect <provider>`, use TUI
`/connect`, or keep using environment/legacy config keys. YAML templates point
`yaml-language-server` at the local `config.schema.json` shipped with the
installed CLI, so editor validation works without a schema server.

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
  "identity": { "model": "deterministic" },
  "run": { "accessMode": "ask" },
  "workspace": "."
}
```

The reserved `deterministic` provider is built in and does not need an
`identity.providers` entry.

### Personal OpenAI-Compatible Provider

Put this in your user config file, for example
`~/.config/sparkwright/config.yaml`:

```json
{
  "identity": {
    "model": "openai/gpt-5.4-mini",
    "providers": {
      "openai": {
        "baseURL": "https://api.openai.com/v1"
      }
    }
  }
}
```

`OPENAI_API_KEY` overrides provider `apiKey` when set. `OPENAI_BASE_URL`
overrides provider `baseURL` when set.

For a bundled provider on its official package and endpoint, `models` may be
omitted: SparkWright lists the bundled catalog and still uses `identity.model`
or `--model` as the deterministic runtime selection. A non-empty `models` map
keeps its legacy meaning as an allowlist and metadata map, so catalog additions
outside that map remain unavailable. A custom package or endpoint does not
inherit official catalog metadata; when it has no allowlist, an explicitly
typed `provider/model` remains valid.

For new configuration, separate selection policy from metadata:

```yaml
identity:
  providers:
    openai:
      modelPolicy:
        allow: [gpt-5.4-mini, gpt-5.4-nano]
        deny: [gpt-5.4-nano]
      modelOverrides:
        gpt-5.4-mini:
          cost:
            input: 1.25
```

`modelPolicy.allow` is an allowlist when present; `deny` is applied afterward.
`modelOverrides` changes cost/provider options but never admits a model. A
provider cannot mix legacy `models` with either new field. Trusted project
policy may narrow a user policy but cannot widen it.

Connect without adding a key to config:

```bash
sparkwright provider connect openai --workspace .
printf '%s\n' "$OPENAI_API_KEY" | \
  sparkwright provider connect openai --api-key-stdin --workspace .

# Browser OAuth with no provider YAML entry
sparkwright provider connect openrouter --workspace .
```

On macOS, stored provider credentials use the operating-system credential
store. Its password prompts run on an isolated system-command terminal, not the
SparkWright CLI/TUI terminal; users should not answer separate `password data`
or `retype password` prompts during `/connect`. If the system helper is
unavailable or returns an unexpected prompt, connection fails without storing
the key. Headless/non-macOS deployments must configure an available backend;
the explicit lower-assurance fallback is
`SPARKWRIGHT_CREDENTIAL_STORE=file`, which uses a 0600 state file. Connection
metadata is separate and never contains the key. Config `apiKey` remains a
legacy plaintext source.

Use `sparkwright provider list --workspace .` to inspect provider models,
non-secret status, and the opaque ids of all stored/ambient connections. Use
`provider select <connection-id>` to switch the workspace to one exact
connection. `provider connect|select|disconnect|remove|refresh` manages stored
connections. Disconnect removes the current workspace grant but keeps the
non-secret entry visible to the trusted local manager as `disconnected`, so it
can be selected again or removed later; remove deletes the stored credential.
`provider login|logout` remains for ambient legacy sources. Metadata is written to
`$XDG_STATE_HOME/sparkwright/provider-auth.json` (normally
`~/.local/state/sparkwright/provider-auth.json`) with exact driver, endpoint,
method, grant, selection, suppression, and revision state but no credential.
OAuth attempts are Host-memory state bound to the initiating local connection;
codes, PKCE verifiers, state, and tokens are not written to that metadata file.
Completed OAuth credentials use the same OS/headless credential-store boundary
as stored API keys. Refresh is serialized per connection and a refresh failure
does not fall back to an environment key.

Refresh code-owned model metadata with
`sparkwright provider catalog refresh [provider] --workspace .`. The Host
keeps a versioned last-known-good cache at
`$XDG_STATE_HOME/sparkwright/provider-catalog.json`; invalid, stale, failed, or
superseded refreshes cannot overwrite newer valid data. Authenticated discovery
is available only where a built-in official driver declares it.

If an older personal config still contains `apiKey`, migrate it explicitly:

```bash
sparkwright provider migrate openai --workspace .
# After verifying the stored connection:
sparkwright provider migrate openai --remove-config --workspace .
```

The removal form checks the exact source value under a cross-process lock,
writes and verifies the credential first, preserves unrelated YAML comments,
and rolls back the new connection if config publication fails.

TUI `/model` groups models by provider. Favorites (`Ctrl+F`) and recent usage
only change picker ordering; they do not change `identity.model`, CLI defaults,
or non-interactive selection.

### Provider Request Options

Use `providerOptions` when an AI SDK provider exposes request-level controls
that SparkWright does not model directly. Provider-level options apply to every
model under that provider; model-level options shallow-override the matching
provider namespace.

Keep these options in the same personal provider entry as the provider's
`baseURL`. Across config layers, a later `providers.openai` entry replaces the
earlier provider entry rather than inheriting its secrets; project
`modelPolicy` is the exception and is conservatively narrowed with user policy.

For OpenAI reasoning summaries:

```json
{
  "identity": {
    "model": "openai/gpt-5.4-mini",
    "providers": {
      "openai": {
        "baseURL": "https://api.openai.com/v1",
        "providerOptions": {
          "openai": {
            "reasoningSummary": "auto"
          }
        },
        "modelPolicy": {
          "allow": ["gpt-5.4-mini"]
        },
        "modelOverrides": {
          "gpt-5.4-mini": {
            "providerOptions": {
              "openai": {
                "reasoningEffort": "low"
              }
            }
          }
        }
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

Put project-wide behavior in `<workspace>/.sparkwright/config.yaml`:

```json
{
  "run": {
    "accessMode": "ask"
  },
  "policy": {
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

Standard tools are enabled by default. Use `tools.use` when a run should only
see broad tool groups, use `tools.allowed` for concrete-name allowlists, and use
`tools.disabled` to close specific tools. `tools.defer` only delays provider
schema loading for the listed built-in tools; it is not a permission boundary.
MCP tools use
`capabilities.mcp.toolSchemaLoad` instead of wildcard tool names. The `write`
block caps a run to a single file with no line deletions; raise
`maxFiles`/`maxDiffLines` or set
`allowDeletions: true` for projects that expect broader edits. Because `write`
merges conservatively, a personal config can tighten these further but a
project config cannot loosen a stricter personal setting.

### Shell Sandbox

The built-in `bash` tool still goes through command classification, policy,
approval, and workspace mutation audit. `policy.sandbox` adds an experimental
OS-level process boundary underneath that flow. The same setting is also used
for configured workflow-hook commands, external-command delegates, and local
stdio MCP servers:

```json
{
  "shell": {
    "foregroundTimeoutMs": 300000,
    "sandbox": {
      "mode": "warn",
      "filesystem": {
        "allowRead": ["."],
        "allowWrite": ["."],
        "denyRead": [".env", ".ssh", ".aws"],
        "denyWrite": [
          ".sparkwright/config.json",
          ".sparkwright/config.yaml",
          ".sparkwright/config.yml"
        ],
        "tmp": true
      },
      "network": {
        "mode": "deny"
      }
    }
  }
}
```

`foregroundTimeoutMs` is the foreground shell budget in milliseconds. It
defaults to `300000` (5 minutes) and is capped at `600000` (10 minutes). When
the budget expires, a host with background task support promotes the live
process; without task promotion, the process is killed and the shell result
reports that promotion was unavailable. The legacy per-call `timeoutMs` field
is rejected by the closed tool schema; use the host-level
`shell.foregroundTimeoutMs` setting instead. It is not a process hard-kill
timeout when promotion is available.

Modes:

- `off`: run through the legacy unsandboxed process executors.
- `warn`: use the platform sandbox when available; otherwise fall back and mark
  supported command result metadata with the unavailable runtime.
- `enforce`: prevent supported local process execution from falling back to an
  unsandboxed process when the platform runtime is missing. It does not upgrade
  the selected OS backend into a stronger filesystem model.

Linux uses `bubblewrap` (`bwrap`) for bind-based filesystem isolation. macOS
uses `sandbox-exec` for deny-list and network controls in this first adapter;
it protects forced deny paths such as SparkWright config state but is not yet a
complete allow-list filesystem sandbox. Other platforms are unsupported in
enforce mode. The host always appends forced deny-write paths for SparkWright
config and capability state so project config cannot remove those protections.
`sparkwright capabilities inspect` reports this distinction as
`fs=bind-allowlist` on Linux and `fs=deny-list-guard` on macOS. Treat the macOS
mode as a guard for configured deny paths and network access, not as evidence
that every unlisted filesystem path is hidden.
Read-only Host runs strengthen local extension processes and Workflow Scripts
to fail-closed no-write profiles. This relies on the backend-specific model
above: Linux removes writable binds, while macOS explicitly denies the
workspace (including stable realpath/private-path variants). It still does not
make the macOS backend a general filesystem allowlist.
Across user, project, and explicit config files, `policy.sandbox` is merged
conservatively: stricter modes, `failIfUnavailable: true`, network deny,
filesystem deny paths, and `tmp: false` win over later weaker settings.

### Add Workflow Hooks

Project hooks live under `capabilities.hooks.workflow`. They attach
deterministic actions to the run lifecycle without relying on the model to
remember a rule.

Use workflow hooks for checked-in project rules: block forbidden paths, inject
project context, run tests after writes, or prevent final answers until required
verification has happened. Lower-level `RunHook` and `UserHookRunner` APIs
remain available for SDK embedders and host integrations,
but they are not the recommended project configuration surface.
For guardrails that should apply only to one configured delegate profile, use
`capabilities.agents.profiles[].hooks` instead of global workflow hooks.
Project config cannot define HTTP hook actions or the HTTP hook transport
policy; keep those in trusted user config or an explicit `SPARKWRIGHT_CONFIG`
file. Run configured HTTP Event Hooks through the normal host-backed
`sparkwright run` path; the internal `--direct-core` diagnostics path does not
promise that transport.

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
            "toolName": ["edit_anchored_text", "edit"],
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

Inject a project rule at run start:

```json
{
  "capabilities": {
    "hooks": {
      "workflow": [
        {
          "name": "testing-rule",
          "hook": "RunStart",
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

Workflow lifecycle names are canonical-only: `RunStart`, `TurnStart`,
`ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`, `RunEnd`, and
`RuntimeSignal`.

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
            "toolName": ["edit_anchored_text", "edit"]
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

Observe a tool event without blocking the run:

```json
{
  "capabilities": {
    "hooks": {
      "events": [
        {
          "name": "log-write",
          "trigger": "tool.completed",
          "matcher": {
            "eventType": "tool.completed",
            "toolName": ["edit_anchored_text", "edit"]
          },
          "action": {
            "type": "command",
            "command": "node",
            "args": ["scripts/log-write.js"]
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
output is added as workflow-hook context. Workflow command hooks can set
`stdin` to `json` to receive `hook`, `run`, `step`, `payload`, and `metadata`;
event command hooks receive `run`, event `payload`, and event metadata. Omit it
or set `none` for the default empty stdin. Set `frequency` to `oncePerTurn` when
a workflow hook should run at most once for the same run step. Command hooks use
the same `policy.sandbox` process boundary as the built-in shell tool.

Set `resultMode` to `stdoutJson` when a command should return a JSON
`WorkflowHookResult` on stdout. This can dynamically return `block`, `rewrite`,
`skipped`, or `continue`; malformed JSON follows the hook's `onError` behavior.
When `stdoutJson` is enabled, stdout is reserved for that final control JSON.
For tool calls, `PreToolUse` runs result-producing rewrite hooks first, applies
argument rewrites, then runs governance/block hooks over the rewritten
arguments before budget, repeat, policy, approval, and tool execution checks.
Rewrites can change tool arguments, not the requested tool name.
Write live progress through the script helper, for example
`progress("checking policy")`, or through the raw stderr wire
`SPARKWRIGHT_EVENT: {"type":"progress","message":"checking policy"}`. The host
strips progress token lines from stderr previews, log artifacts, live output,
and task output before recording process output.
HTTP actions call an `http(s)` URL and can set `resultMode: "responseJson"` to
parse a JSON `WorkflowHookResult`, but they are disabled unless trusted config
sets `capabilities.hooks.http.enabled: true` and an explicit `allow` rule. By
default HTTP hook bodies contain only hook/run summary metadata, not the full
run record or event payload. Private-network destinations require
`allowPrivateNetwork: true`; link-local and cloud metadata addresses remain
blocked. Agent actions call `delegate_agent` by `agentId`;
`resultMode: "workflowResult"` lets the delegate return a workflow result.
Non-blocking `capabilities.hooks.events` rules support `command`, `http`, and
`agent` actions, emit `user_hook.*` evidence, and never block or inject workflow
context.

`PostToolUse` command failures are fed back into the run so the model can
correct course. Pair a post-tool check with a `Stop` hook when a condition must
also be enforced before the final answer.

### Add Verification Profiles

Use `capabilities.verification` when the project wants checked-in quality gates
without hand-writing workflow hooks. Verification commands run through the
project toolchain exactly as configured; SparkWright does not install missing
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
        "injectOutput": "onFailure"
      }
    }
  }
}
```

Modes:

- `off`: disable verification hooks.
- `suggest`: inject the configured profile as guidance, but let the model
  choose when to run commands. This is the default when `mode` is omitted.
- `require`: enforce the selected profile as a run-level invariant and fail
  completed runs when a configured command has not passed after the latest
  workspace write. Freshness is keyed by the run write epoch; commands are
  skipped before the first workspace write and are not re-run while the current
  epoch already has passing results.

`afterWrites.injectOutput` controls whether failed require-mode verifier output
is injected back into retry turns (`always`, `onFailure`, or `never`). The older
`afterWrites.frequency` field was removed with the workflow-runtime P1.5/D25
migration because verification is no longer a PostToolUse hook.

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
          "name": "search",
          "command": "node",
          "args": ["/absolute/path/to/search-mcp.js"],
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

When `cwd` is omitted, stdio MCP servers start from a neutral temporary
directory rather than the workspace. This keeps relative-path writes out of the
project by default. If a server intentionally needs project files, set `cwd`
explicitly and use a risky policy with approval. Relative MCP `cwd` values
resolve from the config file that declares them; in a project
`.sparkwright/config.json`, `"cwd": ".."` points at the workspace root while
`"cwd": "."` points at `.sparkwright/`. HTTP and SSE MCP servers are remote
transports and are governed by MCP policy rather than local process cwd.

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
model: openai/gpt-5.4-mini
use: [workspace.read]
maxSteps: 4
---

Review the proposed change. Focus on correctness, regressions, and missing
tests. Report findings with file references.
```

Profiles describe role guidance and constraints. They do not grant authority by
themselves. Non-`main` profiles that omit `mode` default to child/delegate
agents and are indexed for `delegate_agent`; a Markdown file named `main.md` or
`mode: primary` marks the primary profile. Inline profile `delegateTool` blocks and entries
listed in `capabilities.agents.delegateTools` define optional direct aliases,
and those tools still go through policy, approval, validation, and trace.
Explicit `delegateTools` entries win over inline delegate hints for the same
profile or tool name.

Configured profiles can also attach workflow hooks that run only inside that
profile's in-process child run:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "db-reader",
          "name": "DB Reader",
          "description": "Execute read-only database queries.",
          "use": ["workspace.read", "bash"],
          "hooks": {
            "PreToolUse": [
              {
                "matcher": "bash",
                "action": {
                  "type": "command",
                  "command": "./scripts/validate-readonly-query.sh",
                  "stdin": "json",
                  "blockOnFailure": true,
                  "injectOutput": "onFailure"
                }
              }
            ]
          }
        }
      ]
    }
  }
}
```

Profile hooks apply through `delegate_agent`, direct delegate aliases, and
`delegate_parallel` when the target is a configured in-process delegate. They do
not run on the main agent, dynamic `spawn_agent` children, ACP delegates, or
external-command delegates. Profile hooks support lifecycle names
`RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`,
`RunEnd`, and `RuntimeSignal`, and the action subset `command`, `block`,
`context`, and `http`. The `agent` action is reserved for global workflow
hooks. HTTP actions still follow the trusted HTTP hook policy; project config
profile hooks that use HTTP actions are rejected like global project HTTP hooks.

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

## Canonical Field Map

- `identity.model`: active model in `provider/model` form. The reserved
  `deterministic` provider is built in.
- `identity.providers`: named provider definitions. Keep provider keys in personal
  config, not project config.
- `run.accessMode`: default run autonomy preset (`read-only`, `ask`, `accept-edits`,
  `bypass`). The single user-facing access knob; compiles internally to the
  run's permission/write fields. In project config, this is the workspace
  access ceiling: user, environment, CLI, and TUI runtime requests can ask for a
  stricter mode but cannot exceed the project ceiling.
- `workspace`: default workspace root. Relative paths resolve from the config
  file that defines them.
- `policy.confidentialDefaults`: whether SparkWright includes its built-in conservative
  confidential read defaults (`.env`, common credential/token/secret names, and
  cloud credential folders). Defaults to `true`; set `false` only when the
  config intentionally owns the full confidential read list.
- `policy.confidentialPaths`: additional read-confidentiality globs layered on top of
  SparkWright's built-in confidential defaults unless `confidentialDefaults` is
  `false`. Unions across layers (a later layer can only add entries, never drop
  them).
- `policy.write`: workspace write guardrails (`maxFiles`, `maxDiffLines`,
  `allowDeletions`) that override the runtime defaults. Merges conservatively —
  the smaller `maxFiles`/`maxDiffLines` wins and `allowDeletions: false` wins.
  CLI `--target` is part of this write boundary: it narrows workspace writes and
  write budgets, but it is not a read sandbox. Workspace reads are governed by
  the workspace boundary and confidential read policy, not by `--target`.
- `shell.foregroundTimeoutMs`: foreground shell budget before background
  promotion or no-task-manager kill. Later layers override this scalar.
- `policy.sandbox`: OS-level sandbox for the host shell executor. Merges
  conservatively so a later layer cannot weaken an earlier sandbox policy.
- `run.budget`: resource budget for the interactive main run (`maxModelCalls`,
  `maxToolCalls`, `maxDurationMs`, `maxTokens`, `maxCostUsd`). `maxModelCalls`
  is the tightest natural step bound. An explicit main agent profile under
  `capabilities.agents` overrides this.
- `tasks`: routing and budget defaults for model-backed auxiliary tasks such as
  session compaction. Each `tasks.<name>` entry may set `enabled`, `model`, and
  `budget` (`maxSourceChars`, `maxInputTokens`, `maxOutputTokens`,
  `maxCostUsd`, `unknownCostPolicy`). `maxSourceChars` is the always-enforced
  floor; `maxInputTokens` is currently an advisory tokenizer-aware refinement,
  and dollar caps are only enforceable when pricing is known.
- `run.maxSteps`: explicit main-run step ceiling. Overrides the value derived from
  `run.budget` and the safety backstop.
- `run.traceLevel`: default trace verbosity (`standard`, `debug`) when an
  entrypoint does not pass one. CLI `--trace-level` overrides.
- `run.accessMode`: the single run-autonomy input. CLI `--access-mode` and the TUI
  runtime mode switch can request a temporary mode, subject to the project
  access ceiling.
- `tools`: preferred tool selector, allow/disable, and defer settings.
- `capabilities.skills`: Skill roots and loading behavior.
- `capabilities.mcp`: MCP server definitions, default policy, and MCP tool
  schema loading.
- `capabilities.agents`: agent profiles, profile-scoped child workflow hooks,
  indexed delegation, and optional direct delegate aliases. The default
  `exposure: "indexed"` lets the model call non-opted-out profiles through
  `delegate_agent`; use `pinnedDelegates` or `exposure: "all"` when direct
  `delegate_*` tools are needed. Set `enableParallelDelegates: true` to expose
  the opt-in `delegate_parallel` fan-out tool for read-only configured
  delegates.
- `capabilities.web.security`: built-in URL retrieval transport. `system` is
  the default; `hardened` enables DNS validation and address pinning.
- `ui.theme`, `ui.mouse`, `ui.keybindings`, `ui.vim`: TUI-only preferences. TUI run autonomy uses
  the shared `accessMode`; Shift+Tab changes the mode for the active TUI
  process without writing config.

Child agents and delegate tools do not weaken the parent run. Spawned child
agents inherit the parent run's permission mode, write guardrails, target path,
and confidential read scope before their own agent-profile policy is layered on
top. This means a reviewer or dynamically spawned child cannot read paths the
parent run marks confidential or write outside the parent run's write boundary.

### Canonical Grouped Form

Identity, policy, run, and UI fields are accepted only under their canonical
groups:

```json
{
  "identity": { "model": "openai/gpt-x", "providers": { "openai": {} } },
  "policy": {
    "confidentialDefaults": true,
    "confidentialPaths": ["secrets/**"],
    "write": { "maxFiles": 1 },
    "sandbox": { "mode": "warn" }
  },
  "run": {
    "accessMode": "ask",
    "budget": { "maxModelCalls": 50 },
    "traceLevel": "standard"
  },
  "ui": { "theme": "dark" }
}
```

- `identity` owns `model` and `providers` (belongs in the user config).
- `policy` owns `confidentialDefaults`, `confidentialPaths`, `write`, and
  `sandbox` — the security boundaries. `confidentialPaths`
  unions conservatively; `confidentialDefaults` is the explicit override for the
  built-in confidential path set.
- `run` owns `accessMode`, `backgroundTasks`, `budget`, `maxSteps`, and `traceLevel`.
- `ui` owns `theme`, `mouse`, `keybindings`, and `vim`.
- `capabilities` is already its own group.

Removed root-level aliases are rejected. `workspace`, `shell.foregroundTimeoutMs`,
`tools`, `tasks`, and `capabilities` remain canonical root fields.

### Editor autocomplete and validation

A full JSON Schema ships at `schemas/config.schema.json`, and the CLI package
also includes the same schema under `dist/schemas/` so installed CLIs can use
it for `config validate`. YAML files created by `sparkwright init` include a
`yaml-language-server` schema directive pointing at that local installed schema
with a `file://` URI. For JSON files, or for projects that prefer explicit
workspace mappings, add editor mappings. In VS Code, add a
`json.schemas` mapping for JSON files or the YAML extension's `yaml.schemas`
mapping for YAML files. Keep it in your workspace or user settings
(`.vscode/` is gitignored here, so this stays a personal setting):

```jsonc
// .vscode/settings.json
{
  "json.schemas": [
    {
      "fileMatch": ["**/.sparkwright/config.json", "sparkwright/config.json"],
      "url": "./schemas/config.schema.json",
    },
  ],
  "yaml.schemas": {
    "./schemas/config.schema.json": [
      "**/.sparkwright/config.yaml",
      "**/.sparkwright/config.yml",
      "sparkwright/config.yaml",
      "sparkwright/config.yml",
    ],
  },
}
```

Downstream projects can point `url` at the shipped copy under
`node_modules/@sparkwright/cli/dist/schemas/config.schema.json`. The schema also
permits a top-level `"$schema"` key if you prefer to reference a copy directly
from JSON.

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

- `use`: high-level source/capability selectors retained in the prepared run
  tool set. Omit it to keep the default "all otherwise enabled tools" behavior.
- `allowed`: advanced concrete tool names retained in the prepared run tool
  set. When both `use` and `allowed` are set, SparkWright keeps only tools that
  pass both filters.
- `disabled`: concrete tool names removed from the prepared run tool set.
- `defer`: concrete built-in tool names kept available but omitted from the
  initial provider tool schema until discovered through `tool_search`.

Selectors are: `workspace.read`, `workspace.write`, `bash`, `web`, `planning`,
`skills`, `agents`, `tasks`, `cron`, `mcp`, `mcp:<server>`, `extensions`, and
`extension:<id>`. Multiple selectors in one file are a union; multiple config
layers intersect, so a project can narrow a user setting. For example, user
`use: ["extensions"]` plus project `use: ["extension:workspace.notes"]` yields
only that registered extension's tools.
Model-backed implementation delegates should usually select both
`workspace.read` and `workspace.write`; write-only delegates often cannot find
safe patch anchors. Delegates that select `bash` still require a write-enabled
run, because shell is policy-gated as a side-effecting capability even when a
particular command appears read-only.

The `tool_search` discovery tool is not a selector. It is appended
automatically whenever the resolved tool set still contains deferred tools (so
their schemas can be loaded on demand) and is exempt from `use`/`allowed`
filtering; add `tool_search` to `disabled` to opt out of discovery entirely.

When `defer` is omitted, SparkWright applies a small default defer list for
low-frequency tools (`todo_write`, `read_anchored_text`,
`edit_anchored_text`). Use an explicit empty list (`"defer": []`) to disable
that default. `tools.allowed`, `tools.disabled`, and `tools.defer` accept only
concrete tool names (no wildcards); inspect available names before editing. When
multiple config layers set `allowed`, the effective allowlist is their
intersection. `disabled` is still stricter and removes a tool even if it is also
listed in `use` or `allowed`. Selector-filtered deferred tools keep
`tool_search` available automatically; if you use a concrete `allowed` list for
deferred tools, either also allow `tool_search` or set `"defer": []` so the
provider receives their schemas up front.

The `web` selector contains the main-run-only `web_fetch` tool. It reads one
known public URL without a search provider, browser JavaScript, cookies, or
login state; it does not search for URLs. Each exact normalized URL is
approval-scoped. It returns one cleaned, bounded excerpt; `truncated: true`
means there is no continuation cursor, and another call is a fresh fetch that
may observe a changed page. `web_fetch` is advanced and deferred by default, so
it remains discoverable through `tool_search` unless explicitly disabled.

The default `system` web transport accepts HTTPS and uses normal OS
DNS/routing, so VPN/TUN synthetic addresses work without IP-range exceptions.
It honors the standard `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` environment
variables (plus lowercase forms); `SPARKWRIGHT_WEB_PROXY` can explicitly
override both proxy variables for this tool. It still rejects explicit
private/reserved IPs, local/metadata hostnames, credential-bearing or
secret-bearing URLs, unsafe redirects, compression, oversized responses, and
timeouts.

Use hardened mode when DNS rebinding resistance is more important than local
VPN/TUN compatibility:

```json
{
  "capabilities": {
    "web": { "security": "hardened" }
  }
}
```

`hardened` permits HTTP(S), validates every resolved address as
global-unicast, and pins each connection. Project config may select
`hardened`, but cannot downgrade a user-selected `hardened` mode to `system`;
put an intentional `system` selection in user config or
`$SPARKWRIGHT_CONFIG`.

For a run surface that should only expose one MCP server, prefer a selector:

```json
{
  "tools": {
    "use": ["mcp:demo"]
  }
}
```

The legacy `capabilities.tools` surface (including its `enabled` allowlist and
wildcard patterns) has been removed — move any such config to top-level `tools`.

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
Stdio MCP servers without `cwd` run from a neutral temporary directory; set
`cwd` explicitly only for trusted servers that need local project access.

The CLI can manage user-level tool settings in the first existing user config
file, preserving JSON or YAML formatting:

```bash
sparkwright tools disable bash
sparkwright tools allow mcp_demo_list_tools mcp_demo_call_tool
sparkwright tools defer todo_write
```

Add `--workspace <path>` to manage project defaults in
`<workspace>/.sparkwright/config.{json,yaml,yml}` instead:

```bash
sparkwright tools disable bash --workspace .
sparkwright tools allow mcp_demo_list_tools mcp_demo_call_tool --workspace .
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

`capabilities.skills.inlineShell.enabled` opts into `` !`cmd` `` preprocessing
inside `SKILL.md`. Host runs execute those snippets as no-write, fail-closed
skill scripts: sandbox enforcement is forced, workspace writes are disabled,
and failure inserts only a short marker into the Skill body while trace retains
bounded diagnostics. Inspect the effective policy with
`sparkwright capabilities inspect --workspace . --format text`.

## Agent Profiles

Workspace agent profiles can be managed through the project config file and
project convention directory:

```bash
sparkwright agents list --workspace .
sparkwright agents validate --workspace .
sparkwright agents create reviewer \
  --prompt "Inspect changes for correctness and risk." \
  --model openai/gpt-5.4-mini \
  --use workspace.read \
  --delegate delegate_reviewer \
  --workspace .
```

Markdown profiles are folded under `capabilities.agents.profiles`; if the same
id exists in a config file, the config entry wins. `use` accepts the same broad
tool selectors as top-level `tools.use` and is the recommended capability axis.
Non-`main` profiles that omit `mode` default to child/delegate agents, while
profile id `main` or `mode: primary` marks the primary profile. `allowedTools` remains
an advanced concrete-name allowlist and only narrows the tools selected by
`use`. `capabilities.agents.maxDepth` can cap nested child/delegate spawning
globally. Sub-agents cannot create background tasks; `task_create` remains a
top-level run capability. Advanced fields such as policy and run budget should stay
in the config file.

Profile `hooks` attach workflow hooks to configured in-process child/delegate
runs only. They are useful for per-agent guardrails such as validating a
profile's shell command before it executes. They follow the same lifecycle names
as global workflow hooks, but only support `command`, `block`, `context`, and
`http` actions; they do not support `agent` actions and do not apply to the
main run, dynamic `spawn_agent`, ACP delegates, or external-command delegates.
Project config profile hooks cannot define HTTP actions; keep those in trusted
user config or `SPARKWRIGHT_CONFIG`.

`capabilities.agents.spawnModel` sets the model for ad hoc `spawn_agent`
children. If unset, spawned children inherit the parent run's effective model.
`capabilities.agents.delegateModel` sets the default model for configured
in-process delegates when the profile itself does not set `model`; profile
`model` wins, then `delegateModel`, then the parent run model. ACP and
external-command delegates run across their own process/protocol boundary and
do not use this parent-process model selection.

`capabilities.agents.enableParallelDelegates: true` exposes `delegate_parallel`
as an `agents` selector tool. It is off by default. Calls target configured
agents by `agentId`. Profiles with
`exposeAsDelegate: false` are omitted from the automatic delegation index unless
they are explicitly listed with `delegateTool` / `delegateTools`. The first
version only runs configured in-process delegates that are read-only
(`workspaceAccess: "none"`) and have no shell access; ACP, external-command,
workspace-writing, and shell delegates are rejected with a diagnostic. The call
is foreground blocking and starts every accepted child before waiting for all
results.

## Cost Metadata

Provider model entries can attach per-million-token pricing for usage reports:

```json
{
  "identity": {
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
}
```

Models not listed in `models` can still run; they simply lack attached cost
metadata.

## TUI Preferences

```json
{
  "ui": {
    "theme": "dark",
    "mouse": true,
    "vim": false,
    "keybindings": {
      "activity.open": "ctrl+o",
      "help.open": "?",
      "cancel.run": "esc",
      "quit.app": "ctrl+c"
    }
  }
}
```

`theme`, `mouse`, and `keybindings` are TUI-only. TUI run autonomy uses the
shared run `accessMode`; the interactive selector
(`read-only`, `ask`, `accept-edits`, `bypass`) is a runtime override for the
current TUI process and is clamped by any project access ceiling.
Provider, model, run `accessMode`, and workspace settings apply to both CLI and
TUI surfaces.
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
`config validate` loads the config, checks each loaded file against the shipped
schema, runs loader/semantic validation, and exits non-zero when there are
errors. `config inspect` prints the effective merged config with secret-looking
fields redacted. `config explain` focuses on where each resolved field came
from. `config example <name>` prints a copy-pasteable snippet in the grouped
form (names: `write`, `sandbox`, `run`, `hooks`, `verification`, `mcp`,
`agent`). `capabilities inspect` is read-only.
It summarizes the workspace, effective tool filters, Skill roots and shadows,
agent roots and shadows, MCP servers, cron state paths, and command
directories. `doctor paths` prints the installation, config, capability, user
state, and workspace state paths without starting a run.

## Install And Upgrade Safety

SparkWright treats config and project capabilities as user-owned assets:

- Package installation does not create or modify config files.
- First interactive use may scaffold the user config once, using the same
  non-overwriting template as `sparkwright init`.
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

- If a provider model is unknown, confirm `identity.model` uses `provider/model`
  form and that the provider key exists under `identity.providers`.
- If an API key is ignored, check whether the matching environment variable is
  overriding config.
- If a tool disappeared, look for top-level `tools.use`, `tools.allowed`,
  `tools.disabled`, `tools.defer`, and MCP server `enabled` settings.
- If a project setting does not combine with a user setting, remember that most
  fields other than `identity.providers` are replaced wholesale — except the
  security boundaries (`run.accessMode`, `policy.confidentialPaths`,
  `policy.write`, `policy.sandbox`), which merge conservatively. Project
  `run.accessMode` is a ceiling; requests above it are clamped.
  `policy.confidentialDefaults` is the explicit later-layer override
  for the built-in confidential deny set.
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
- Tool allow/disable/defer changes should be visible in trace.
- TUI-only cosmetic changes may be lower risk.
- Agent-generated config diffs should be stored as artifacts.

This keeps configuration changes inspectable and recoverable instead of turning
settings into invisible prompt state. The implementation contract is maintained
in this guide and [Extension Interfaces](../reference/EXTENSION_INTERFACES.md).
