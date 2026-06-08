# Sparkwright

A modular runtime substrate for building inspectable, policy-aware agent
applications.

Sparkwright separates the agent runtime kernel, host boundary, and product
surfaces so teams can build custom CLIs, TUIs, IDE extensions, bots, workflow
agents, and backend services on the same governed execution model.

It is not a chatbot framework or a coding IDE clone. It is the execution
infrastructure around a model: tools, context, policy, approvals, workspace
changes, artifacts, sessions, and trace.

## Architecture At A Glance

```txt
Product surfaces
CLI / TUI / SDK clients / future IDEs, bots, and web clients
        |
        v
Host boundary
config / providers / skills / MCP / tools / protocol / sessions
        |
        v
Runtime kernel
run lifecycle / context / policy / approval / workspace / artifacts / trace
```

The layers are deliberately separate:

- `core` defines the execution semantics for governed agent runs.
- `host` composes providers, tools, skills, MCP, configuration, sessions, and
  transport protocols around the kernel.
- `cli` and `tui` are current product surfaces, not the whole product.
- `protocol` and `sdk-*` make the host usable from other clients.

## Why Teams Use It

Most agent products eventually need more than a prompt loop. They need a
runtime boundary where:

- a goal becomes a run
- the model sees bounded context
- tools are registered and validated
- risky actions pass through policy and approval
- workspace edits produce durable artifacts
- every meaningful step is emitted as structured events and trace

Sparkwright makes that boundary reusable. The model provides generation and
reasoning; Sparkwright owns the controlled execution path around it.

Key advantages:

- **Runtime/UI decoupling** - build a CLI, TUI, IDE extension, bot, workflow
  worker, or backend service without rewriting the execution runtime.
- **Composable capability model** - add tools, skills, MCP servers, project
  context, and agent profiles through explicit boundaries instead of forking the
  run loop.
- **Governance built in** - policy, approval, workspace mutation, trace, and
  artifacts are first-class runtime concerns.
- **Observable and recoverable runs** - structured events, JSONL trace,
  sessions, checkpoints, and resume support make agent execution debuggable and
  auditable.
- **Replaceable edges** - providers, storage, context sources, product shells,
  and transports stay outside the core kernel.
- **Local-first path with product headroom** - the source tree proves the local
  CLI/TUI path today while preserving a host protocol and SDK path for future
  clients.

## Current Status

Sparkwright is pre-v0. It is a runnable kernel for local agent harnesses, not a
production sandbox or a complete end-user agent product.

The deterministic CLI path currently proves:

- run lifecycle and structured events
- tool execution with schema validation
- approval-gated workspace mutation
- diff artifacts
- durable session storage
- JSONL trace output

Real provider runs are opt-in through configuration or CLI flags.

## Where It Fits

Use Sparkwright when you are building:

- a coding or repository automation agent
- an agent-backed CLI or TUI
- an IDE or editor extension
- an internal workflow agent
- a bot or IM gateway
- a backend service that needs governed agent execution

Sparkwright is not intended to be a hosted agent SaaS, generic chatbot
framework, GUI workbench, RAG platform, or production sandbox by itself.

## Install From Source

Sparkwright currently runs from source. The npm package is not published yet, so
`npm install -g @sparkwright/cli` is not available.

```bash
git clone <repo>
cd SparkWright
bash ./install.sh
```

The install script runs `npm install`, builds the workspace, and links the
`@sparkwright/cli` package so `sparkwright` is available on your PATH.

Manual equivalent:

```bash
npm install
npm run build
npm link --workspace @sparkwright/cli
```

## First Run

Run a deterministic local smoke test without an API key:

```bash
sparkwright run "inspect this repo" --workspace . --model deterministic
```

From the source checkout, you can also run the CLI without linking:

```bash
npm run cli -- run "inspect this repo" --workspace . --model deterministic
```

Allow a workspace write and approve it automatically:

```bash
sparkwright run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard \
  --model deterministic
```

That command works inside `examples/repo-pilot`, routes writes through the
approval path, creates a diff artifact, and writes trace data under:

```txt
examples/repo-pilot/.sparkwright/sessions/<session-id>/
```

Omit `--yes` to review the approval prompt yourself. Omit `--write` for a
read-only run.

## Interactive TUI

Launch the terminal UI:

```bash
sparkwright tui
```

If `--workspace` is omitted, Sparkwright uses the current working directory. To
open a specific project:

```bash
sparkwright tui --workspace /path/to/your/project
```

From the source checkout, you can also run:

```bash
npm run tui
```

The CLI and TUI run from compiled output. After pulling changes or editing
source, rebuild with `npm run build`, or use `npm run cli -- ...` /
`npm run tui`, which build first.

## ACP Agent Server

Run Sparkwright as an Agent Client Protocol (ACP) agent server for local
editors and ACP clients:

```bash
sparkwright acp --workspace /path/to/your/project
```

The command speaks ACP JSON-RPC over stdio. ACP is an edge protocol here:
Sparkwright still owns the governed runtime path for policy, approval,
workspace writes, artifacts, and trace.

Sparkwright can also delegate a bounded sub-task to another ACP-compatible
agent process through an agent profile:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_reviewer",
          "name": "External Reviewer",
          "prompt": "Review changes and report concrete risks.",
          "metadata": {
            "acp": {
              "transport": "stdio",
              "command": "codex",
              "args": ["acp"],
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

The external agent is launched as a local subprocess over stdio. The delegate
tool remains a governed Sparkwright tool and requires approval by default.

For local tools that do not expose ACP, use a generic external command profile:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_cli_reviewer",
          "name": "External CLI Reviewer",
          "metadata": {
            "externalCommand": {
              "command": "agent-cli",
              "args": ["run", "{{goal}}"],
              "envMode": "inherit",
              "input": "none",
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

`externalCommand` uses `spawn` directly, not a shell. `args` may contain
`{{goal}}`, `{{metadataJson}}`, and `{{workspaceRoot}}`; `input` can be
`argument`, `stdin`, or `none`. Non-zero exits fail the delegate unless listed
in `successExitCodes`. `envMode` defaults to `inherit`; set it to `explicit`
to pass only the configured `env` map. `maxStdoutBytes` and `maxStderrBytes`
control output capture limits independently, with `maxOutputBytes` retained as
a shared fallback.

Run a configured external delegate directly while debugging:

```bash
sparkwright delegates run delegate_external_cli_reviewer \
  --workspace /path/to/your/project \
  --goal "Inspect README.md and return one concise suggestion." \
  --session-id delegate-debug \
  --trace-level debug \
  --yes
```

This direct path still applies the delegate approval gate. Use `--yes` only in
trusted local debugging contexts. The command writes a normal session trace
under `.sparkwright/sessions/<session-id>/trace.jsonl`.

## Configure A Provider

The deterministic model is built in for local smoke tests. For provider-backed
runs, configure a provider/model pair and API key:

```bash
sparkwright init
```

Then edit the generated user config and run with a provider model:

```bash
OPENAI_API_KEY=... sparkwright run "inspect this repo" \
  --workspace . \
  --model openai/<model-name> \
  --trace-level standard
```

See [Configuration](./docs/guides/CONFIGURATION.md) for config file locations,
project config, provider settings, permission modes, skills, tools, MCP, and
agent profiles.

## Core Concepts

- `Run` - one execution of an agent task.
- `Tool` - a typed capability with schema validation and policy metadata.
- `Context` - bounded input material available to a run.
- `Policy` - the rule layer that allows, denies, or requires approval.
- `Approval` - a first-class pause point before risky actions.
- `Artifact` - durable output such as a patch, file, report, or log.
- `Trace` - append-only structured events for debugging, replay, and audit.

## Repository Map

- `packages/core` - run lifecycle, event model, tools, policy, approvals,
  sessions, trace, and workspace primitives.
- `packages/host` - host runtime, configuration, capability loading, and
  stdio/WebSocket transport.
- `packages/cli` - command-line interface and TUI launcher.
- `packages/tui` - interactive terminal product surface.
- `packages/acp-adapter` - Agent Client Protocol server adapter for local
  editor/client integration.
- `packages/acp-client-adapter` - Agent Client Protocol client worker for
  delegating to external ACP-compatible agent processes.
- `packages/protocol` - shared host protocol types.
- `packages/sdk-core` and `packages/sdk-node` - client SDKs for talking to a
  host.
- `packages/provider-registry` - provider/model selection edge.
- `packages/skills` - skill loading and validation.
- `packages/mcp-adapter` - MCP capability bridge.
- `packages/cron` - background task scheduling primitives.
- `examples` - small runnable examples and smoke targets.
- `docs` - guides, reference docs, maintainer runbooks, and ADRs.

## Documentation

If you are new to the project:

- [User Manual](./docs/guides/USER_MANUAL.md) - run the CLI/TUI and inspect traces.
- [Configuration](./docs/guides/CONFIGURATION.md) - configure providers, models, permission mode, workspace, and TUI preferences.
- [Capability Design Guide](./docs/guides/CAPABILITY_DESIGN_GUIDE.md) - choose between skills, tools, MCP, agent profiles, policy, approvals, and background tasks.
- [Custom Tool Example](./docs/guides/CUSTOM_TOOL_EXAMPLE.md) - add a tool with validation, policy, and trace.
- [Troubleshooting](./docs/guides/TROUBLESHOOTING.md) - common local setup and runtime issues.

Reference docs:

- [Architecture](./docs/reference/ARCHITECTURE.md)
- [Extension Interfaces](./docs/reference/EXTENSION_INTERFACES.md)
- [Protocol](./docs/reference/PROTOCOL.md)
- [Host Protocol](./docs/reference/HOST_PROTOCOL.md)
- [Provider Edge](./docs/reference/PROVIDER_EDGE.md)
- [Skills](./docs/reference/SKILLS.md)

For the full documentation map, see [docs/README.md](./docs/README.md).
For AI-agent-oriented maintenance, start with
[AI Task Index](./docs/maintainer/AI_TASK_INDEX.md).

## Community

- License: [Apache-2.0](LICENSE)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
