# Sparkwright

Composable runtime primitives for safe, inspectable agent-native apps.

Sparkwright is a TypeScript runtime for building the harness around a model: tools, context, policy, approvals, workspace changes, artifacts, sessions, and trace.

It is not a chatbot framework or a coding IDE clone. It is the runtime layer underneath agent-native CLIs, backends, developer tools, workflow systems, local automation agents, and product-specific assistants.

## Quick Start

Run the local deterministic CLI path:

```bash
npm install
npm run build
npm run cli -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

That command works inside `examples/repo-pilot`, routes writes through the approval path, creates a diff artifact, and writes a JSONL trace under `.sparkwright/sessions/<session-id>/trace.jsonl`.

For an interactive terminal UI:

```bash
npm run tui
```

The CLI and TUI run from compiled output. After pulling changes or editing source, rebuild with `npm run build`, or use `npm run cli -- ...` / `npm run tui`, which build first.

## What It Does

Sparkwright gives agent applications reusable runtime pieces:

- run lifecycle and structured events
- tool execution with schema validation
- policy and approval gates
- controlled workspace edits and artifacts
- durable sessions and JSONL trace
- provider adapters, usage tracking, and extension hooks
- skills, MCP, sub-agents, and background task primitives at the edge

## When To Use It

Use Sparkwright when you need an inspectable agent runtime that can sit behind a CLI, host process, TUI, bot, workflow, or backend service.

It is a good fit when tool calls, file changes, approvals, traceability, and recoverability matter. It is not meant to be a complete end-user agent product, a GUI-first IDE, or a general chatbot framework.

## Start Reading

If you are new to the project:

- [User Manual](./docs/guides/USER_MANUAL.md) - run the CLI/TUI and inspect traces.
- [Configuration](./docs/guides/CONFIGURATION.md) - configure providers, models, permission mode, workspace, and TUI preferences.
- [Capability Design Guide](./docs/guides/CAPABILITY_DESIGN_GUIDE.md) - choose between skills, tools, MCP, agent profiles, policy, approvals, and background tasks.
- [Custom Tool Example](./docs/guides/CUSTOM_TOOL_EXAMPLE.md) - add a tool with validation, policy, and trace.
- [Troubleshooting](./docs/guides/TROUBLESHOOTING.md) - common local setup and runtime issues.

For the full documentation map, see [docs/README.md](./docs/README.md).

## Reference

- [Architecture](./docs/reference/ARCHITECTURE.md)
- [Extension Interfaces](./docs/reference/EXTENSION_INTERFACES.md)
- [Protocol](./docs/reference/PROTOCOL.md)
- [Host Protocol](./docs/reference/HOST_PROTOCOL.md)
- [Provider Edge](./docs/reference/PROVIDER_EDGE.md)
- [Skills](./docs/reference/SKILLS.md)

For AI-agent-oriented maintenance, start with [AI Task Index](./docs/maintainer/AI_TASK_INDEX.md).

## Project Status

Sparkwright is pre-v0. It is a runnable kernel for local agent harnesses, not a production sandbox or complete agent product.

The deterministic CLI path currently proves trace, tool execution, approval-gated workspace mutation, diff artifacts, and durable session storage. Real provider runs are opt-in through configuration or CLI flags.

## Community

- License: [Apache-2.0](LICENSE)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
