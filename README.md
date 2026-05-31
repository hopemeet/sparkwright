# Sparkwright

Composable harness runtime primitives for safe, inspectable agent-native apps.

Sparkwright is a TypeScript runtime for building agent harnesses: the execution environment around a model that manages tools, context, policy, approvals, workspace changes, artifacts, and trace.

It is not a chatbot framework or a coding-IDE clone. It is the runtime layer underneath agent-native CLIs, backends, developer tools, workflow systems, and local automation agents.

## Why

Agent-native applications are moving beyond GUI-first interaction. Many useful apps will look like CLIs, background workers, CI jobs, Slack or Feishu bots, local daemons, IDE extensions, and workflow steps. These systems need a reliable agent runtime more than they need another chat UI.

Sparkwright focuses on the hard reusable pieces of agent harness engineering:

- run lifecycle
- tool execution
- structured events
- approval gates
- policy enforcement
- workspace edits
- trace now, replay later
- model-agnostic adapters
- validation hooks
- lifecycle middleware (`RunHook`)
- unified outbound channel (`InteractionChannel`)
- user-intent commands (`CommandRegistry`)
- per-run usage / cost aggregation (`UsageTracker`)
- failure-to-rule ratchets

## Start Here

Use this path if you are new to the project:

1. [User Manual](docs/USER_MANUAL.md) - run the CLI/TUI, inspect trace output, and understand the basic workflow.
2. [Configuration](docs/CONFIGURATION.md) - configure providers, models, permission mode, workspace, and TUI preferences.
3. [Capability Design Guide](docs/CAPABILITY_DESIGN_GUIDE.md) - decide when to use Skills, Tools, MCP, agent profiles, policy, approvals, and background tasks.
4. [Automation And Background Tasks](docs/AUTOMATION_AND_BACKGROUND_TASKS.md) - understand long-running commands today and the host-owned scheduling model.

After that, read [Architecture](docs/ARCHITECTURE.md), [Extension Interfaces](docs/EXTENSION_INTERFACES.md), and [Protocol](docs/PROTOCOL.md) for deeper implementation contracts.

## Where to extend

The most common extension points. Each row links to the type or factory in
`@sparkwright/core` and the doc section that explains the contract.

| You want to…                                   | Use                                                                                                                     | Read                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Give the model a new action                    | `defineTool` + `ToolDefinition`                                                                                         | [EXTENSION_INTERFACES.md#tool-extensions](docs/EXTENSION_INTERFACES.md)                                                   |
| Inject context from a source                   | `ContextExtension` (skills, memory, retrieval)                                                                          | [EXTENSION_INTERFACES.md#context-extensions](docs/EXTENSION_INTERFACES.md)                                                |
| Add one named prompt layer                     | `PromptSection` / `additionalSections`                                                                                  | [CONTEXT_PLANE.md#promptsection](docs/CONTEXT_PLANE.md)                                                                   |
| Observe / narrowly steer the loop              | `RunHook` (`createRun({ hooks })`)                                                                                      | [EXTENSION_INTERFACES.md#run-hooks](docs/EXTENSION_INTERFACES.md)                                                         |
| Ask the user / approve / notify (any frontend) | `InteractionChannel`                                                                                                    | [EXTENSION_INTERFACES.md#interaction-channel](docs/EXTENSION_INTERFACES.md)                                               |
| Register slash commands (CLI / desktop / bot)  | `CommandRegistry` + `CommandDefinition`                                                                                 | [EXTENSION_INTERFACES.md#commands](docs/EXTENSION_INTERFACES.md)                                                          |
| Track tokens / cost for billing / dashboards   | `UsageTracker` (`createRun({ usageTracker })`)                                                                          | [EXTENSION_INTERFACES.md#usage-tracker](docs/EXTENSION_INTERFACES.md)                                                     |
| Add or override policy                         | `createLayeredPolicy`, `createPermissionModePolicy`                                                                     | [EXTENSION_INTERFACES.md](docs/EXTENSION_INTERFACES.md)                                                                   |
| Route across multiple models                   | `createRoutingModelAdapter`, `createFallbackModelAdapter`                                                               | [PROVIDER_EDGE.md](docs/PROVIDER_EDGE.md)                                                                                 |
| Register provider/model choices                | `ProviderRegistry` (`@sparkwright/provider-registry`)                                                                   | [PROVIDER_EDGE.md](docs/PROVIDER_EDGE.md)                                                                                 |
| Run after-turn streaming                       | `createStreamingRun` (`@sparkwright/streaming-runtime`)                                                                 | [STREAMING_LOOP_REQUIREMENTS.md](docs/STREAMING_LOOP_REQUIREMENTS.md)                                                     |
| Run a sub-agent / child run                    | `spawnSubAgent`, `mountAgentTool` (`@sparkwright/agent-runtime`)                                                        | [EXTENSION_INTERFACES.md#sub-agents](docs/EXTENSION_INTERFACES.md)                                                        |
| Fan out multiple sub-agents in parallel        | `ConcurrencyCoordinator` + `acquireWorktree` + `createTodoTools` + `parseSubAgentResult` (`@sparkwright/agent-runtime`) | [EXTENSION_INTERFACES.md#concurrency-control-multi-sub-agent-fan-out](docs/EXTENSION_INTERFACES.md)                       |
| Persist or replay a run                        | `RunStore`, `SessionStore`, `replaySessionEventsFromRunStore`                                                           | [STATE_AND_TRACE_MODEL.md](docs/STATE_AND_TRACE_MODEL.md) · [PROTOCOL.md](docs/PROTOCOL.md)                               |
| Run a long shell as a background task          | `createShellTool({ foregroundTimeoutMs, onPromote })` + `TaskManager`                                                   | [ENVIRONMENT.md#foreground--background-promotion-opt-in](docs/ENVIRONMENT.md) · [example](examples/promote-shell-to-task) |
| Surface task completion to the agent loop      | `TaskNotificationSink` / `InMemoryTaskNotificationQueue` (`@sparkwright/agent-runtime`)                                 | [example](examples/promote-shell-to-task)                                                                                 |
| Inject out-of-band signals into the next turn  | `NotificationSource` (`createStreamingRun({ notificationSources })`)                                                    | [STREAMING_LOOP_REQUIREMENTS.md](docs/STREAMING_LOOP_REQUIREMENTS.md) · [example](examples/promote-shell-to-task)         |

AI maintainers: every `packages/core/src/*.ts` file carries a short
"AI maintenance note" header pointing at the relevant doc section. Start
there before editing.

## First Use Case

The local CLI golden path can be exercised after building the workspace:

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

That command reads and writes only inside `examples/repo-pilot`, routes the write through approval, creates a diff artifact, and saves a JSONL trace under `examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl`. Omit `--yes` to review the approval prompt yourself, or omit `--write` for a read-only trace smoke test.

The deterministic model is the default so the golden path is stable in tests and demos. A provider-backed OpenAI run can use the same harness path when `OPENAI_API_KEY` is set:

```bash
OPENAI_API_KEY=... npm run cli -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --model openai/<model-name> \
  --trace-level standard
```

An interactive terminal UI is available. Use the root script, which rebuilds
the workspace before launching so the compiled `dist/` is never stale:

```bash
npm run tui
```

> The CLI and TUI run from compiled output (`packages/cli/dist`). After pulling
> changes or editing source, rebuild before launching directly — `npm run build`,
> or use `npm run tui` / `npm run cli -- run "<goal>"`, which build first.
> Running `node packages/cli/dist/index.js …` against a stale `dist/` can fail
> with missing-export errors.

Trace detail can be selected by the caller:

```bash
npm run cli -- run "inspect this repo" --trace-level minimal
npm run cli -- run "inspect this repo" --trace-level standard
npm run cli -- run "inspect this repo" --trace-level debug
npm run cli -- trace summary examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
npm run cli -- trace events examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --type tool.failed --limit 20 --jsonl
npm run cli -- trace timeline examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
npm run cli -- session check <session-id> --workspace examples/repo-pilot --format text
npm run cli -- session repair <session-id> --workspace examples/repo-pilot --dry-run
npm run cli -- session resume <session-id> "continue the investigation" --workspace examples/repo-pilot
```

A successful v0 run should be able to:

- create an agent run
- gather bounded context
- call registered tools
- request approval before risky actions
- edit files through workspace primitives
- produce a diff artifact
- save a JSONL execution trace

This coding workflow is the first proving ground, not the final product boundary.

See [Repo Pilot](examples/repo-pilot/README.md) and [CLI Golden Path](docs/CLI_GOLDEN_PATH.md) for the current runnable path and expected trace/artifact outputs.
See [Custom Tool Example](docs/CUSTOM_TOOL_EXAMPLE.md), [Troubleshooting](docs/TROUBLESHOOTING.md), and [v0 Release Checklist](docs/RELEASE_CHECKLIST.md) for the current release-readiness workflow.

## Project Status

Sparkwright is pre-v0. It is a runnable kernel for local agent harnesses, not a production sandbox or complete agent product.

The deterministic CLI golden path currently proves trace, tool execution, approval-gated workspace mutation, diff artifacts, and durable session storage. Real provider runs are opt-in through configuration or CLI flags.

For the current release-readiness workflow, see [v0 Release Checklist](docs/RELEASE_CHECKLIST.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

## What Sparkwright Is

- A TypeScript-first runtime toolkit for agent-native applications.
- A set of composable primitives: `Run`, `Step`, `Tool`, `Context`, `Event`, `Approval`, `Policy`, and `Artifact`.
- A protocol-oriented foundation that can later support Python SDKs, Rust execution components, server adapters, and workflow integrations.
- A framework for making agent behavior inspectable, controllable, and recoverable.
- A small harness kernel with replaceable edges for providers, memory, context, storage, validation, and workspace backends.

## What Sparkwright Is Not

- Not a complete agent product.
- Not a GUI-first IDE or workbench.
- Not a general chatbot framework.
- Not tied to one model provider.
- Not a large RAG or long-term memory platform.
- Not a promise to implement the core runtime in every language.

## Design Principles

- Inspectable by default.
- Composable before magical.
- Protocol over implementation.
- Human approval as a first-class primitive.
- Local-first, backend-ready.
- Safe mutation for files, shell, and external systems.
- Model adapters at the edge, not in the core.
- Thin loop, strong boundaries.
- Model proposes, harness disposes.
- Context is a budget, not a bucket.

## Documentation

- [User Manual](docs/USER_MANUAL.md)
- [Configuration](docs/CONFIGURATION.md)
- [Capability Design Guide](docs/CAPABILITY_DESIGN_GUIDE.md)
- [Automation And Background Tasks](docs/AUTOMATION_AND_BACKGROUND_TASKS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Extension Interfaces](docs/EXTENSION_INTERFACES.md)
- [Protocol](docs/PROTOCOL.md)
- [Host Protocol](docs/HOST_PROTOCOL.md)
- [Provider Edge](docs/PROVIDER_EDGE.md)
- [Skills](docs/SKILLS.md)
- [Custom Tool Example](docs/CUSTOM_TOOL_EXAMPLE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

For AI-agent-oriented maintenance, start with [AI Task Index](docs/AI_TASK_INDEX.md).

## API Stability

`@sparkwright/core` exports two surfaces:

- **`@sparkwright/core`** — public API. Types, factories (`createRun`, `defineTool`, `createDefaultPolicy`, `createBufferedEmitter`, …), and extension interfaces (`RunStore`, `TraceSink`, `MemoryStore`, `SessionStore`, `Compactor`, `ContextExtension`, `ToolExtension`, `EventEmitter`, `Policy`, `ContextAssembler`, `PromptSection`, `PromptBuilder`, …). Semver-tracked from v0.1 onward.
- **`@sparkwright/core/internal`** — reference implementation classes (`SparkwrightRun`, `EventLog`, `FileRunStore`, `MemoryTrace`, `LocalWorkspace`, `ControlledWorkspace`, `DefaultContextAssembler`, `DefaultPromptBuilder`, `DefaultObservationFormatter`). These are tagged `@internal`; they remain re-exported from the top-level entry for backward compatibility, but new consumers should depend on the public API and only reach into `./internal` when extending core. Pin a minor version when doing so — shapes may move in 0.x.

For an AI-agent–oriented map of extension tasks → entry points, see [`docs/AI_TASK_INDEX.md`](docs/AI_TASK_INDEX.md). Protocol evolution is tracked in [`docs/PROTOCOL_CHANGELOG.md`](docs/PROTOCOL_CHANGELOG.md).

## Community

- License: [Apache-2.0](LICENSE)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

Sparkwright is early. Small, well-scoped issues and PRs are the most useful way to help shape the runtime without muddying the core abstractions.
