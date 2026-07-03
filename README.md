# SparkWright

The execution boundary your agent needs before it can touch a real repo.

SparkWright turns model output into governed, inspectable runs: typed tools,
policy checks, approval-gated workspace diffs, resumable sessions, and JSONL
trace.

The deterministic smoke path uses no API key:

```bash
sparkwright run "inspect this repo" --workspace . --model deterministic
```

Use SparkWright when an agent needs to do real work in a workspace without
becoming an untraceable prompt loop.

## Why It Exists

Agent products eventually need more than a model loop. They need a boundary
where:

- goals become structured, resumable runs
- tools are typed, schema-validated, and policy-tagged
- risky actions go through policy and explicit approval
- workspace edits become reviewable diffs and artifacts
- every meaningful step lands in JSONL trace

SparkWright makes that boundary reusable instead of re-implemented per product.

## Quick Start

SparkWright currently runs from source. The npm package is not published yet, so
`npm install -g @sparkwright/cli` is not available.

Use Node.js `^22.13.0 || >=24` (the repo includes `.node-version` for version
managers).

```bash
git clone <repo>
cd SparkWright
bash ./install.sh
```

Then run the deterministic smoke path:

```bash
sparkwright run "inspect this repo" --workspace . --model deterministic
```

Optional from here:

```bash
# Inspect the configured runtime surface (tools, skills, MCP, agents)
sparkwright capabilities inspect --workspace . --format text

# Inspect install, config, capability, state, and workspace paths
sparkwright doctor paths --workspace . --format text

# Launch the interactive terminal UI
sparkwright tui --workspace .
```

The script installs an independent copy under `~/.sparkwright`. Add
`~/.sparkwright/bin` to your `PATH` if the script reports it is not already
present.

SparkWright keeps program files (`~/.sparkwright`) separate from user config
(`~/.config/sparkwright`), user state (`~/.local/state/sparkwright`), and project
data (`<workspace>/.sparkwright`). For the full layout and provider setup, see
[Configuration](./docs/guides/CONFIGURATION.md).

For provider-backed runs, run `sparkwright init` and follow
[Configuration](./docs/guides/CONFIGURATION.md).

## Where It Fits

Use it for:

- coding and repository-automation agents
- agent-backed CLIs and TUIs
- IDE/editor or ACP client integrations
- internal workflow agents, bots, and IM gateways
- backend services that need governed agent execution

It is not a hosted agent SaaS, generic chatbot framework, GUI workbench, RAG
platform, or production sandbox by itself.

## Current Status

SparkWright is **pre-v0**. It is a runnable local agent runtime and host, not a
production sandbox or a finished end-user product.

- Runnable local CLI / TUI / host path today.
- Deterministic smoke runs need no API key.
- Provider-backed runs are opt-in through config or CLI flags.
- Not a production sandbox; not a hosted service.

## How A Run Works

```txt
Goal -> Surface -> Host -> Runtime kernel -> Evidence
```

| Layer          | Responsibility                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface        | CLI, TUI, ACP, or SDK collects intent and renders progress.                                                                                  |
| Host           | Loads config, picks providers, assembles skills, MCP, agents, and sessions.                                                                  |
| Runtime kernel | Runs the governed loop: assembles context, calls the model, dispatches typed tools, enforces policy and approvals, applies workspace writes. |
| Evidence       | Persists JSONL trace, artifacts, diffs, diagnostics, and resume state.                                                                       |

## Core Capabilities

- **Tool orchestration** — typed tools with schema validation and recoverable
  argument errors.
- **Policy and approvals** — allow, deny, or pause before risky actions.
- **Workspace mutation and artifacts** — approval-gated writes with diff
  artifacts and rollback.
- **Sessions and resume** — checkpointed runs you can continue.
- **Trace and diagnostics** — JSONL trace with summaries, timelines, and
  verification.
- **Skills, MCP, agents, and background tasks** — composable capabilities and
  durable long-running work.

## Common Entry Points

- **Run the CLI/TUI and basic runs** — [User Manual](./docs/guides/USER_MANUAL.md)
- **Configure providers, models, paths, and preferences** — [Configuration](./docs/guides/CONFIGURATION.md)
- **Define agent profiles and delegate tools** — [Agent Profiles](./docs/guides/AGENTS.md)
- **Run long work and scheduled jobs** — [Automation and Background Tasks](./docs/guides/AUTOMATION_AND_BACKGROUND_TASKS.md)
- **ACP server and external delegates** — [User Manual](./docs/guides/USER_MANUAL.md) and [Agent Profiles](./docs/guides/AGENTS.md)
- **Decide between skills, tools, MCP, and agents** — [Capability Design Guide](./docs/guides/CAPABILITY_DESIGN_GUIDE.md)
- **Add a custom tool** — [Custom Tool Example](./docs/guides/CUSTOM_TOOL_EXAMPLE.md)
- **Architecture and contracts** — [Architecture](./docs/reference/ARCHITECTURE.md), [Protocol](./docs/reference/PROTOCOL.md), [Host Protocol](./docs/reference/HOST_PROTOCOL.md)

## Repository Map

- `packages/core` — run lifecycle, events, tools, policy, approvals, sessions,
  trace, workspace primitives.
- `packages/host` — host runtime, configuration, capability loading, transports.
- `packages/cli` and `packages/tui` — current product surfaces.
- `packages/acp-adapter` and `packages/acp-client-adapter` — ACP server and
  external-agent delegation.
- `packages/protocol` and `packages/sdk-*` — host protocol and client SDKs.
- `packages/skills`, `packages/mcp-adapter`, `packages/cron` — capability
  bridges and scheduling.
- `examples` — small runnable examples and smoke targets.
- `docs` — guides, reference docs, runbooks, and ADRs.

## Documentation

Start with the [documentation map](./docs/README.md), which is organized by
reader intent (guides, reference, maintainer). For AI-agent-oriented
maintenance, see the [AI Task Index](./docs/maintainer/AI_TASK_INDEX.md).

## Community

- License: [Apache-2.0](LICENSE)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
