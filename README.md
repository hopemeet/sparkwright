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

The first validation target is a local coding agent runtime:

```bash
sparkwright run "inspect this repo and suggest a README improvement"
```

The local CLI golden path can be exercised after building the workspace:

```bash
npm install
npm run build
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

That command reads and writes only inside `examples/repo-pilot`, routes the write through approval, creates a diff artifact, and saves a JSONL trace under `examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl`. Omit `--yes` to review the approval prompt yourself, or omit `--write` for a read-only trace smoke test.

The deterministic model is the default so the golden path is stable in tests and demos. A provider-backed OpenAI run can use the same harness path when `OPENAI_API_KEY` is set:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <model-name> \
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
npm exec sparkwright -- run "inspect this repo" --trace-level minimal
npm exec sparkwright -- run "inspect this repo" --trace-level standard
npm exec sparkwright -- run "inspect this repo" --trace-level debug
npm exec sparkwright -- trace summary examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
npm exec sparkwright -- trace events examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --type tool.failed --limit 20 --jsonl
npm exec sparkwright -- trace timeline examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
npm exec sparkwright -- session check <session-id> --workspace examples/repo-pilot --format text
npm exec sparkwright -- session repair <session-id> --workspace examples/repo-pilot --dry-run
npm exec sparkwright -- session resume <session-id> "continue the investigation" --workspace examples/repo-pilot
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

## Current Implementation Status

Sparkwright is pre-v0.

Implemented today:

- TypeScript monorepo skeleton
- core run record and event log
- in-memory JSONL trace serialization
- tool registry and basic tool execution
- experimental execution environment boundary with deny-by-default local process skeleton
- policy and approval data primitives, including layered and permission-mode policies
- tool governance policy helpers and approval timeout resolution
- local workspace path boundary checks
- approval-gated workspace writes through the run runtime
- diff artifact events for proposed workspace writes
- file-backed run storage under `.sparkwright/runs/<run-id>/`
- durable JSONL trace files and artifact files
- experimental session/replay primitives for grouping runs and projecting run traces
- file-backed session storage and run trace replay loading
- configurable trace levels: `minimal`, `standard`, and `debug`
- default trace and artifact redaction for common secret keys and token-shaped strings
- minimal Context Plane interfaces and default implementations
- optional context compaction assembler wrapper
- bounded context assembly with omission metadata
- stable-before-dynamic prompt message building
- provider-neutral `PromptSection` composition with section cache policy metadata
- provider-neutral prompt cache block compilation via `compilePromptCacheBlocks`
- default prompt sections for harness identity, tool use, safety/approval, context trust, output honesty, eager tools, and deferred capability deltas
- compact observation formatting for tool results
- provider-edge model routing, fallback, and abortable adapter helpers
- AI SDK provider edge package for real model adapters
- optional provider registry for model metadata, selection, and adapter caching
- optional CLI OpenAI provider path through the AI SDK adapter
- CLI golden path using a deterministic model, workspace tools, approval-gated writes, and JSONL trace output
- core loop hardening with run results, stop reasons, guarded terminal states, doom-loop detection, tool timeouts, and model retry events
- experimental extension packages for Skills, MCP tool ingress, and agent profile policy helpers
- Skill lockfile generation, MCP context descriptor normalization, and agent profile run-option compilation
- capability runtime example composing Skills, MCP, agent policy, and core run primitives
- `tool_search` lazy-loading discovery tool for `deferLoading: true` tools, keeping per-turn prompt small when MCP / skill tools are numerous
- multi-tier compaction triggers (`tool_result_budget` / `snip` / `micro` / `collapse` / `auto` / `reactive`) with shipped reference stages for the cheap edits
- prompt-cache integrity detector emitting `context.cache_break.detected` when a stable prefix changes between turns
- `forkSessionFromEvent` helper for branching a session at a specific event for AI debugging
- `UserHookRunner` contract for settings.json-style user-configurable shell hooks (core defines vocabulary, host owns execution)
- background-task primitives (`TaskManager`, `task_*` tools, `TaskStore`) for work spawned by a run that the model can poll, cancel, and stream output from
- sandboxed `@sparkwright/shell-tool` package with three-tier safety (allow / require_approval / deny) and a destructive-command blocklist
- description-matching `@sparkwright/skills` discovery protocol with directory loader, registry, and capability projection
- structured `InteractionChannel` question schema (`multiSelect`, `header`, `preview`, `selectedChoiceIds`) for uniform frontend rendering across CLI / desktop / bot hosts
- v1.1 host wire protocol (stdio + WebSocket) defined in `schemas/host-message.schema.json` and documented in [docs/HOST_PROTOCOL.md](docs/HOST_PROTOCOL.md); shared types live in `@sparkwright/protocol`
- `@sparkwright/host` standalone process that owns the agent runtime and speaks the wire protocol over stdio or WebSocket
- `run.inject_message` request for mid-run steering (protocol v1.1)
- isomorphic client SDKs: `@sparkwright/sdk-core` (transport-agnostic `Client`), `@sparkwright/sdk-node` (spawn or attach to a host), `@sparkwright/sdk-browser` (pure ESM, native WebSocket)
- interactive Ink-based terminal UI in `@sparkwright/tui`, wired to the host through the client SDK
- `@sparkwright/im-gateway` IM gateway with a Telegram adapter as the first platform
- internal-imports gate (`scripts/check-internal-imports.mjs`) to keep core's `src/internal/*` from leaking across packages

Not implemented yet:

- auth store, production routing service, and production streaming service
- production-grade memory, retrieval, compaction, session resume, and multi-agent orchestration
- Skill marketplace, hot reload, durable lockfile enforcement, and auto-update
- live MCP resources and prompts discovery as context sources
- full deterministic replay and resume

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

## Planning References

- [User Manual](docs/USER_MANUAL.md)
- [Configuration](docs/CONFIGURATION.md)
- [Capability Design Guide](docs/CAPABILITY_DESIGN_GUIDE.md)
- [Automation And Background Tasks](docs/AUTOMATION_AND_BACKGROUND_TASKS.md)
- [Harness Principles](docs/HARNESS_PRINCIPLES.md)
- [Harness Component Model](docs/HARNESS_COMPONENT_MODEL.md)
- [State And Trace Model](docs/STATE_AND_TRACE_MODEL.md)
- [Context Plane](docs/CONTEXT_PLANE.md)
- [Extension Interfaces](docs/EXTENSION_INTERFACES.md)
- [Skills](docs/SKILLS.md)
- [Trace Extension Events](docs/TRACE_EXTENSION_EVENTS.md)
- [Run Events](docs/RUN_EVENTS.md)
- [Skill, MCP, And Agent Capability Model](docs/SKILL_MCP_AGENT_CAPABILITY_MODEL.md)
- [Extension Release Checklist](docs/EXTENSION_RELEASE_CHECKLIST.md)
- [Provider Edge](docs/PROVIDER_EDGE.md)
- [Reference Notes](docs/REFERENCE_NOTES.md)
- [Protocol](docs/PROTOCOL.md)
- [Custom Tool Example](docs/CUSTOM_TOOL_EXAMPLE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [v0 Release Checklist](docs/RELEASE_CHECKLIST.md)

## Extension Map (AI-native quick reference)

Every reusable seam in the core loop has a single interface, a single file,
and (usually) a single factory or option in `createRun`. This table is the
map an AI agent should consult before adding behavior to Sparkwright. New
extensions should land in additive, optional fields here — never by
forking the loop.

| I want to…                               | Interface / option                                 | File / factory                                                      |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Plug in a model provider                 | `ModelAdapter`                                     | `packages/provider-ai-sdk` / `core/src/model.ts`                    |
| Configure provider model selection       | `ProviderRegistry` / `ProviderDefinition`          | `packages/provider-registry`                                        |
| Add a fallback chain                     | `createRun({ models })`                            | `core/src/run.ts`                                                   |
| Use after-turn streaming                 | `createStreamingRun`                               | `packages/streaming-runtime`                                        |
| Register a custom tool                   | `ToolDefinition` / `defineTool`                    | `core/src/tools.ts`                                                 |
| Influence tool concurrency               | `ToolDefinition.isConcurrencySafe`                 | `core/src/tools.ts` + `tool-orchestration.ts`                       |
| Add per-stage context compaction         | `CompactionStage` (pipeline)                       | `core/src/pipeline.ts`                                              |
| Wrap a single-shot compactor as a stage  | `compactionStageFromCompactor`                     | `core/src/pipeline.ts`                                              |
| Shape context selection                  | `ContextAssembler`                                 | `core/src/context.ts`                                               |
| Add one named prompt layer               | `PromptSection` / `additionalSections`             | `core/src/context.ts`                                               |
| Build prompt messages                    | `PromptBuilder`                                    | `core/src/context.ts`                                               |
| Format tool observations                 | `ObservationFormatter`                             | `core/src/context.ts`                                               |
| Summarize a tool batch async             | `ObservationSummarizer`                            | `core/src/pipeline.ts`                                              |
| Prefetch skills / memory in parallel     | `ContextPrefetcher`                                | `core/src/pipeline.ts`                                              |
| Gate model output before completion      | `ValidationHook` (`pre_terminal`)                  | `core/src/validation.ts`                                            |
| Observe model output asynchronously      | `ValidationHook` (`post_sampling`)                 | `core/src/validation.ts`                                            |
| Validate a tool result / workspace write | `ValidationHook` (other stages)                    | `core/src/validation.ts`                                            |
| Enforce permissions on actions           | `Policy` / `createLayeredPolicy`                   | `core/src/policy.ts`                                                |
| Require human approval                   | `ApprovalResolver`                                 | `core/src/approval.ts`                                              |
| Persist events durably                   | `RunStore` / `FileRunStore`                        | `core/src/storage.ts` / `trace.ts`                                  |
| Stream events to an external sink        | `TraceSink`                                        | `core/src/storage.ts`                                               |
| Cancel mid-stream / mid-tool             | `runHandle.cancel()` / `abortSignal`               | `core/src/run.ts` (signals propagate to tools)                      |
| React to context overflow                | Recovery hint `reduce_input`                       | `core/src/run.ts` (extractRecoveryHint)                             |
| React to truncated output                | Recovery hint `extend_output`                      | `core/src/run.ts` (max_output_tokens)                               |
| Recover via a different model            | Recovery hint `fallback_model`                     | `core/src/run.ts`                                                   |
| Inspect or replay a run                  | `SessionStore` / `replaySessionEventsFromRunStore` | `core/src/session.ts`                                               |
| Add Skill / MCP / agent-policy bundling  | extension packages                                 | `packages/skills`, `packages/mcp-adapter`, `packages/agent-runtime` |
| Add backend control plane                | `@sparkwright/server-runtime`                      | `packages/server-runtime`                                           |
| Add safe coding workspace tools          | `@sparkwright/coding-tools`                        | `packages/coding-tools`                                             |
| Lazy-load tool schemas (`tool_search`)   | `createToolSearchTool`, `ToolSearchSource`         | `core/src/tool-search.ts`                                           |
| Detect prompt-cache breakage             | `wrapPromptBuilderWithCacheBreakDetector`          | `core/src/cache-break.ts`                                           |
| Fork a session at a specific event       | `forkSessionFromEvent`                             | `core/src/session.ts`                                               |
| Run user-configurable hooks              | `UserHookRunner` + `bindUserHooks`                 | `core/src/user-hooks.ts`                                            |
| Reference compaction stages (multi-tier) | `createToolResultBudgetStage`, `createSnipStage`   | `core/src/pipeline.ts`                                              |
| Spawn long-running background tasks      | `TaskManager`, `task_*` tools                      | `packages/agent-runtime/src/tasks/`                                 |
| Sandboxed shell tool with safety tiers   | `createShellTool` + destructive-pattern blocklist  | `packages/shell-tool/src/`                                          |
| Load + match skills (description-based)  | `loadSkillsFromDirectory`, `SkillRegistry`         | `packages/skills/src/`                                              |
| Load project instruction files           | `createProjectInstructionsExtension`               | `packages/project-context`                                          |

### Loop invariants worth knowing before extending

- **Prompt-cache safety.** Once a `PromptMessage` is emitted with
  `stability: "stable"`, the loop must not modify it on subsequent turns —
  byte-identical prefixes are how every major provider's prompt cache
  reuses tokens. New extensions that mutate context must do so by replacing
  `turn`-stability items or by appending; never by editing earlier `stable`
  items in place. See [`docs/CONTEXT_PLANE.md`](docs/CONTEXT_PLANE.md).
- **Sections before loop forks.** Prompt input should be extended by
  registering `PromptSection` values or producing `ContextItem` values.
  Dynamic Skills, MCP inventories, and agent-scoped capability lists belong in
  `session`/`turn` context or capability delta sections, not in frequently
  rewritten stable tool schema blocks.
- **State is rewritten per iteration.** Every `continue` point in the loop
  constructs a fresh `RunLoopState` object with an explicit
  `transition.reason`. Do not mutate the previous state in place; do not
  push directly into `state.context`. See the `RunLoopTransitionReason`
  JSDoc in `core/src/types.ts` for the enumerated values and their meaning.
- **Recoveries do not consume a turn.** Errors carrying a `recoveryHint`
  route through `model_recovery` transitions that re-enter the loop without
  incrementing `step`. Stop hooks that block termination DO consume a turn
  (`stop_hook_blocked`).
- **Prefetch and summarizer are best-effort.** Their failures are logged
  but never abort the run. If an extension absolutely must surface its
  errors, register it as a regular `ValidationHook` instead.

## Current Repository Shape

```txt
sparkwright/
  packages/
    core/
    cli/
    protocol/
    host/
    sdk-core/
    sdk-node/
    sdk-browser/
    tui/
    im-gateway/
    provider-ai-sdk/
    provider-registry/
    streaming-runtime/
    skills/
    skill-curator/
    mcp-adapter/
    agent-runtime/
    server-runtime/
    coding-tools/
    shell-tool/
    project-context/
    trace-perfetto/
  examples/
    repo-pilot/
    custom-tool/
    capability-runtime/
    promote-shell-to-task/
    python-subprocess/
  schemas/
  docs/
```

The implementation stays intentionally small. Internal modules may map to future packages, but v0 avoids premature package sprawl.

## API Stability

`@sparkwright/core` exports two surfaces:

- **`@sparkwright/core`** — public API. Types, factories (`createRun`, `defineTool`, `createDefaultPolicy`, `createBufferedEmitter`, …), and extension interfaces (`RunStore`, `TraceSink`, `MemoryStore`, `SessionStore`, `Compactor`, `ContextExtension`, `ToolExtension`, `EventEmitter`, `Policy`, `ContextAssembler`, `PromptSection`, `PromptBuilder`, …). Semver-tracked from v0.1 onward.
- **`@sparkwright/core/internal`** — reference implementation classes (`SparkwrightRun`, `EventLog`, `FileRunStore`, `MemoryTrace`, `LocalWorkspace`, `ControlledWorkspace`, `DefaultContextAssembler`, `DefaultPromptBuilder`, `DefaultObservationFormatter`). These are tagged `@internal`; they remain re-exported from the top-level entry for backward compatibility, but new consumers should depend on the public API and only reach into `./internal` when extending core. Pin a minor version when doing so — shapes may move in 0.x.

For an AI-agent–oriented map of extension tasks → entry points, see [`docs/AI_TASK_INDEX.md`](docs/AI_TASK_INDEX.md). Protocol evolution is tracked in [`docs/PROTOCOL_CHANGELOG.md`](docs/PROTOCOL_CHANGELOG.md).

## Project Status

Sparkwright is a pre-v0 runnable kernel. The deterministic local CLI golden path proves trace, tool execution, approval-gated workspace mutation, diff artifacts, and durable run storage. The remaining v0 work is release hardening: protocol/schema stabilization, package metadata, examples, troubleshooting, and provider-backed smoke verification.

## Community

- License: [Apache-2.0](LICENSE)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

Sparkwright is early. Small, well-scoped issues and PRs are the most useful way to help shape the runtime without muddying the core abstractions.
