# AI Task Index

This index maps common extension tasks to their entry points in the SparkWright kernel. It is written for AI agents extending or modifying the runtime. Each entry names the file to start in, the interface to satisfy, the docs required for context, the schemas or contracts that must be updated when behavior changes, and the wiring point that activates the extension.

Read the linked entry file first, then the linked docs, then make the change. Do not invent extension points that are not listed below; if a task does not appear here, fall back to `docs/reference/EXTENSION_INTERFACES.md` and the relevant reference docs.

---

### Task: Add a new storage backend (e.g. SQLite, Postgres)

- **Entry point**: `packages/core/src/trace.ts` (`FileRunStore` is the reference implementation)
- **Interface to implement**: `RunStore` in `packages/core/src/storage.ts`
- **Must read**: `docs/reference/STATE_AND_TRACE_MODEL.md`, `docs/reference/EXTENSION_INTERFACES.md`, `docs/reference/PROTOCOL.md` (file trace section), `docs/reference/ARCHITECTURE.md`
- **Must update on change**: nothing in `schemas/` (storage sits below the protocol layer); update `packages/core/src/index.ts` only if exporting new types
- **Wire in via**: `createRun({ runStore })` — accepts either a `RunStore` instance or a `(run: RunRecord) => RunStore` factory (used by `FileRunStore`, which needs the minted `run.id`). Use `createSessionRunStoreFactory` when a session store must record `sessionId -> runId` membership alongside run persistence. The kernel backfills any pre-subscribe events (e.g. `run.created`), forwards every subsequent event via `runStore.append`, and calls `runStore.finish(record, result)` on terminal state. Errors thrown by the store are logged via `console.warn` and never break the run.
- **Notes**: `loadEvents` and `writeArtifact` are optional; minimum is `append` + `finish`. Treat the `RunStore` as single-writer per run.

### Task: Add a new model provider (hosted API, local model, or gateway)

- **Entry point**: `packages/provider-ai-sdk/src/index.ts` (reference adapter)
- **Interface to implement**: `ModelAdapter` (see `packages/core/src/types.ts`)
- **Must read**: `docs/reference/PROVIDER_EDGE.md`, `docs/reference/PROTOCOL.md` (`model.requested` / `model.completed` payloads), `docs/reference/ARCHITECTURE.md`
- **Must update on change**: nothing in `schemas/` unless adding new event payload fields; provider-level retries should default to `0` so the kernel owns retry trace
- **Wire in via**: `createRun({ model: yourAdapter })` in `packages/core/src/run.ts`
- **Notes**: Normalize tool calls and stop reasons to the core shapes. Do not bypass `policy` or emit fake events. Use `createRoutingModelAdapter`, `createFallbackModelAdapter`, or `createAbortableModelAdapter` for service-edge routing, fallback, and cancellation without changing the run loop.

### Task: Register provider/model selection for a product shell

- **Entry point**: `packages/provider-registry/src/index.ts`
- **Interface to implement**: `ProviderDefinition` plus `ModelInfo`
- **Must read**: `docs/reference/PROVIDER_EDGE.md`
- **Must update on change**: package README and tests under `packages/provider-registry/test`
- **Wire in via**: `registry.getAdapter("provider:model")`, then pass the resolved `ModelAdapter` to `createRun` or `createStreamingRun`
- **Notes**: The registry should not call provider APIs directly unless a provider definition chooses to. Keep auth/config and SDK construction at the edge.

### Task: Use after-turn streaming

- **Entry point**: `packages/streaming-runtime/src/index.ts`
- **Interface to consume**: `createStreamingRun({ model, tools, ... })`
- **Must read**: `docs/reference/STREAMING_LOOP_REQUIREMENTS.md`, `docs/reference/PROTOCOL.md` (streaming events)
- **Must update on change**: package README and tests under `packages/streaming-runtime/test`
- **Wire in via**: choose `createStreamingRun` from a product/control-plane layer when the selected model supports `stream()`
- **Notes**: First version is after-turn only. Do not add eager tool execution without explicit policy, cancellation, and replay tests.

### Task: Add a new tool with risk + approval

- **Entry point**: `packages/core/src/tools.ts` (`defineTool`)
- **Interface to implement**: `ToolDefinition` (input schema, `policy.risk`, `policy.requiresApproval`, `execute`)
- **Must read**: `docs/reference/EXTENSION_INTERFACES.md` (Tool Extensions), `docs/guides/CUSTOM_TOOL_EXAMPLE.md`, `docs/reference/PROTOCOL.md` (tool section)
- **Must update on change**: `schemas/tool.schema.json` if the tool envelope grows new top-level fields; otherwise no schema change
- **Wire in via**: `createRun({ tools: [...], interactionChannel })`. Approval is automatic when `policy.requiresApproval` is true and `interactionChannel.approve` is configured.
- **Notes**: Risky side effects belong in `governance.sideEffects`. Long outputs should become artifacts, not prompt context.

### Task: Use the official coding workspace tools

- **Entry point**: `packages/coding-tools/src/index.ts`
- **Interface to consume**: `createCodingTools({ workspaceRoot })`
- **Must read**: `packages/core/src/anchored-edit.ts` and `docs/adr/0003-anchored-edits-over-line-numbers.md`
- **Must update on change**: package README and tests under `packages/coding-tools/test`
- **Wire in via**: `createRun({ workspace, tools: createCodingTools({ workspaceRoot }) })`
- **Notes**: Reads and anchored edits must flow through `RuntimeContext.workspace`; directory discovery must stay contained to `workspaceRoot`.

### Task: Add a new context source (memory, RAG, file selector)

- **Entry point**: `packages/core/src/context.ts` (`DefaultContextAssembler`)
- **Interface to implement**: `ContextItem` producer; optionally a custom `ContextAssembler`
- **Must read**: `docs/reference/CONTEXT_PLANE.md`, `docs/reference/EXTENSION_INTERFACES.md` (Context Extensions)
- **Must update on change**: no schema change for items; if introducing a new `metadata.layer` value, document it in `docs/reference/CONTEXT_PLANE.md`
- **Wire in via**: `createRun({ context: [...] })` for static items, or `createRun({ contextAssembler })` for dynamic selection
- **Notes**: Tag each item with stable `source`, `metadata.layer`, and `metadata.stability` so trace can explain the selection.

### Task: Add a new event type

- **Entry point**: `packages/core/src/events.ts` (`EventType` union)
- **Interface to implement**: extend the `EventType` union; emit through `EventLog.emit`
- **Must read**: `docs/reference/PROTOCOL.md` (event envelope), `docs/reference/TRACE_EXTENSION_EVENTS.md`
- **Must update on change**: `schemas/event.schema.json` (add the new type to the enum and any payload constraints); add filter rules in `packages/core/src/trace.ts` for `standard` so the event is summarized appropriately
- **Wire in via**: emit at the boundary that produces the new fact; subscribers and `FileRunStore` pick it up automatically
- **Notes**: Prefer reusing existing types with new `metadata` fields when possible (see ADR 0002).

### Task: Add a new EventType and ensure trace redaction handles it

- **Entry point**: `packages/core/src/trace.ts` (look at the `applyTraceLevel` / redactor path)
- **Interface to implement**: extend `EventType`, extend the level-summarizer, and confirm the default redactor walks any new payload shape
- **Must read**: `docs/reference/PROTOCOL.md` (trace levels), `docs/reference/TRACE_EXTENSION_EVENTS.md`, `docs/reference/STATE_AND_TRACE_MODEL.md`
- **Must update on change**: `schemas/event.schema.json`; add tests in `packages/core/test/trace.test.ts` covering standard/debug and redaction
- **Wire in via**: nothing extra at the run boundary; redaction is applied inside `FileRunStore` (or any `RunStore`)
- **Notes**: New payloads carrying secrets must match the existing key/value regex patterns or extend them.

### Task: Bracket work in a span (correlate `*.started` / `*.completed`)

- **Entry point**: `packages/core/src/spans.ts` (`withSpan`, `withSpanSync`, `openSpan`, `emitInSpan`, `currentSpan`)
- **Interface to implement**: nothing — call `withSpan(emitter, { startType, endType }, async (frame) => …)`. Children emitted from inside `fn` inherit the parent via `AsyncLocalStorage` automatically.
- **Must read**: `docs/adr/0008-span-correlation-and-trace-sinks.md`, `docs/reference/PROTOCOL.md` ("Span Correlation" section)
- **Must update on change**: nothing in `schemas/` (the envelope fields are already present); add a test mirroring `packages/core/test/spans.test.ts`
- **Wire in via**: pass the `EventEmitter` you already hold (`run.events`, a buffered emitter, or any wrapper). The `EventLog` strips the private `__span` metadata key automatically.
- **Notes**: Use `openSpan` only for long-lived lifecycles whose start and end live in different scopes (background `Task`s, detached streaming responses). For everything else, prefer `withSpan` so the ALS frame is correct for free.

### Task: Add a new trace sink (visualizer, OTel bridge, log shipper)

- **Entry point**: `packages/trace-perfetto/src/index.ts` (reference implementation; subscribe-only, no mutation)
- **Interface to implement**: any object that calls `emitter.subscribe(listener)` and translates `SparkwrightEvent` into the target format
- **Must read**: `docs/reference/STATE_AND_TRACE_MODEL.md`, ADR `0006-jsonl-traces-with-tiered-detail.md` (why events are facts, not span trees), ADR `0008-span-correlation-and-trace-sinks.md` (how to pair start/end via `spanId`)
- **Must update on change**: nothing in `schemas/` — sinks consume the existing envelope. New packages should be added to `docs/maintainer/EXTENSION_RELEASE_CHECKLIST.md`.
- **Wire in via**: subscribe at the run boundary (`run.events.subscribe(…)`) or wrap with a helper like `attachPerfettoSink({ source: run.events, outPath })`
- **Notes**: Treat absence of `spanId` as "no span info" — degrade to an instant marker rather than dropping the event. Never block emission; sinks must be safe to throw inside without breaking the loop.

### Task: Add a new interaction channel (Slack, web UI, CI gate)

- **Entry point**: `packages/core/src/interaction.ts`
- **Interface to implement**: `InteractionChannel` (`approve` is the approval handler)
- **Must read**: `docs/reference/EXTENSION_INTERFACES.md` (Approval Extensions), ADR `0004-approval-gated-workspace-writes.md`, `docs/reference/PROTOCOL.md` (approval events)
- **Must update on change**: no schema change; the `approval.requested` / `approval.resolved` payloads are already stable
- **Wire in via**: `createRun({ interactionChannel: yourChannel })`
- **Notes**: Requests and responses must remain JSON-serializable so trace can replay them. Do not mutate the run record from inside the channel.

### Task: Add a custom policy (capability rule)

- **Entry point**: `packages/core/src/policy.ts`
- **Interface to implement**: `Policy`; compose multiple policies with `createLayeredPolicy`, or wrap a base policy with `createPermissionModePolicy`
- **Must read**: `docs/reference/EXTENSION_INTERFACES.md` (Policy Extensions), `docs/guides/CAPABILITY_DESIGN_GUIDE.md`, `docs/guides/CONFIGURATION.md`
- **Must update on change**: no schema change; if decisions surface in trace metadata, document the new fields
- **Wire in via**: `createRun({ policy: yourPolicy })`
- **Notes**: Policy must base decisions on structured inputs (tool name, risk, path, agent id), not prompt wording. Deny decisions should remain authoritative across modes; approval-like decisions should be explicit so frontends and services can route them.

### Task: Add a new skill / load skills from a directory

- **Entry point**: `packages/skills/` (extension package, not core)
- **Interface to implement**: skill manifest matching `schemas/skill-manifest.schema.json`; adapter normalizes manifest into `ContextItem[]` + `ToolDefinition[]`
- **Must read**: `docs/reference/SKILLS.md`, `docs/guides/CAPABILITY_DESIGN_GUIDE.md`, `docs/reference/EXTENSION_INTERFACES.md` (Skill Extensions)
- **Must update on change**: `schemas/skill-manifest.schema.json` if the manifest shape grows; trace should carry Skill `name` + `packageHashPolicyVersion: 2` + `packageHash`
- **Wire in via**: `prepareSkillsForRun({ skillRoots })` then `createRun({ context: prepared.context, tools: prepared.tools })`
- **Notes**: Skill scripts must enter as governed tools; reading a `SKILL.md` must not have side effects.

### Task: Make commands / agent profiles / config follow a project (file-authored)

- **Entry point**: new edge package `packages/project-commands/` (alongside `packages/project-context/`); assembly hooks in `packages/host/src/runtime.ts`; scaffold + gitignore in `packages/cli/src/cli.ts` and `.gitignore`
- **Interface to implement**: discover `.sparkwright/command/*.md` and `.sparkwright/agents/*.md`, parse frontmatter into front-end-agnostic command descriptors and `agent-profile` records; per-front-end adapters bind descriptors into the embedder's command registry
- **Must read**: `docs/guides/CONFIGURATION.md`, `docs/guides/AGENTS.md`, `docs/reference/EXTENSION_INTERFACES.md` (Commands, Multi-Agent Extensions), `schemas/agent-profile.schema.json`
- **Must update on change**: `docs/reference/EXTENSION_INTERFACES.md` Commands section if the `start_run` intent metadata shape changes; `.gitignore` runtime-subpath allowlist
- **Wire in via**: `resolveAgentProfiles(workspaceRoot, agentConfig)` between config load and profile finalization in `runtime.ts` (used by both assembly paths); commands via descriptor + adapter, never core `CommandRegistry` directly
- **Notes**: Explicit `config.json` wins over convention md files. The `` !`shell` `` interpolation is the only execution-touching path and must run through the shell-tool gate. Core is not modified.

### Task: Add an MCP server integration

- **Entry point**: `packages/mcp-adapter/`
- **Interface to implement**: MCP client wrapper mapping tools to `ToolDefinition` and resources to `ContextItem`
- **Must read**: `docs/reference/EXTENSION_INTERFACES.md` (MCP Extensions), `docs/guides/CAPABILITY_DESIGN_GUIDE.md`, `docs/guides/CONFIGURATION.md`, `schemas/mcp-server-config.schema.json`
- **Must update on change**: `schemas/mcp-server-config.schema.json` for config-shape changes; carry `mcp:<server>` origin in tool/context metadata
- **Wire in via**: register adapter output through `createRun({ tools, context })`
- **Notes**: Core must not depend on MCP protocol details. Connection lifecycle and protocol translation live in the adapter.

### Task: Productize host/TUI capability runtime

- **Entry point**: `packages/host/src/runtime.ts` for run assembly, `packages/host/src/config.ts` for config loading, `packages/tui/src/state/run-controller.ts` and `packages/tui/src/state/event-store.ts` for TUI projection
- **Interface to implement**: host-owned capability assembly from config into `ContextItem[]`, `ToolDefinition[]`, policy, run metadata, and extension events; optional protocol request for capability inspection
- **Must read**: `docs/guides/CAPABILITY_DESIGN_GUIDE.md`, `docs/guides/CONFIGURATION.md`, `docs/reference/HOST_PROTOCOL.md`, `docs/reference/EXTENSION_INTERFACES.md`
- **Must update on change**: `schemas/config.schema.json` for config shape; `schemas/host-message.schema.json` and `packages/protocol/src/index.ts` if adding capability inspection RPC; TUI tests for capability projections and panels
- **Wire in via**: host prepares Skills/MCP/agents before `createRun()`, flushes buffered extension events onto `run.events`, and exposes host-authored snapshots to the TUI
- **Notes**: The TUI must not load Skills, discover MCP servers, or interpret agent profiles as runtime authority. It may inspect host facts and provide light controls only after those controls are backed by config, policy, and trace.

### Task: Implement a compaction strategy

- **Entry point**: `packages/core/src/context.ts` (look for `context.compaction_requested` emission sites)
- **Interface to implement**: a `Compactor` (introduced in v0.1 alongside the other extension shapes; consume context items and produce a smaller item set)
- **Must read**: `docs/reference/CONTEXT_PLANE.md`, `docs/reference/PROTOCOL.md` (compaction events)
- **Must update on change**: emit `context.compaction_requested` with structured payload; no schema change unless adding payload fields
- **Wire in via**: a custom `ContextAssembler` that runs the compactor before returning items
- **Notes**: Compaction is not memory; long-term recall belongs in `MemoryStore`.

### Task: Add a workflow hook

- **Entry point**: `packages/core/src/workflow-hooks.ts` for execution and `packages/host/src/workflow-hooks.ts` for configured actions
- **Interface to implement**: `WorkflowHook` with a canonical lifecycle name, matcher, and deterministic result
- **Must read**: `docs/reference/EXTENSION_INTERFACES.md` (Workflow Hooks), `docs/reference/RUN_EVENTS.md`
- **Must update on change**: emit the appropriate `workflow_hook.*` events and update the config schema for new configured shapes
- **Wire in via**: `createRun({ workflowHooks: [...] })` or `capabilities.hooks.workflow`
- **Notes**: Blocking and rewrite results must remain serializable so traces explain every policy decision.

### Task: Add an artifact type

- **Entry point**: `packages/core/src/workspace.ts` (diff artifacts are the reference) and `packages/core/src/types.ts` (`Artifact`)
- **Interface to implement**: emit `artifact.created` with a typed payload; the `RunStore` materializes it
- **Must read**: `docs/reference/PROTOCOL.md` (artifact section), `docs/reference/STATE_AND_TRACE_MODEL.md`
- **Must update on change**: extend `Artifact` discriminant in `types.ts`; document the new kind in `docs/reference/PROTOCOL.md`
- **Wire in via**: produced from inside a tool or workspace path; not a user-facing option
- **Notes**: Large or sensitive data must enter as an artifact, not as inline event payload.

### Task: Implement session / multi-turn

- **Entry point**: `packages/core/src/session.ts` (`InMemorySessionStore` and `FileSessionStore` are the reference implementations)
- **Interface to implement**: `SessionStore`; use `AppendOnlySessionStore` when the backend persists session-local events
- **Must read**: `docs/reference/STATE_AND_TRACE_MODEL.md`, `docs/reference/PROTOCOL.md` (session events)
- **Must update on change**: no schema change in v0.1; session id, if surfaced in events, goes in `metadata`
- **Wire in via**: embedder owns the session loop today: call `session.append(id, run.record.id)` after each `createRun`; use `replaySessionEventsFromRunStore({ session, runStore })` to project persisted run traces into a session replay stream
- **Notes**: Sessions are not memory; cross-run recall lives in `MemoryStore`. Resume should rebuild trust and approval state rather than carrying permissions across session boundaries.

### Task: Add an execution environment backend (shell, hosted sandbox, remote worker)

- **Entry point**: `packages/core/src/environment.ts` if present; otherwise create it and export public protocols from `packages/core/src/index.ts`
- **Interface to implement**: `ExecutionEnvironment` with structured request/result objects and policy-ready metadata
- **Must read**: `docs/maintainer/ENVIRONMENT.md`, `docs/guides/CONFIGURATION.md`, `docs/guides/CAPABILITY_DESIGN_GUIDE.md`
- **Must update on change**: add tests for denial, timeout metadata, and serializable outputs; update protocol schemas only if environment events become first-class trace events
- **Wire in via**: expose environment-backed capabilities as governed tools, or pass the environment through an embedder-owned runtime context until core wires it directly
- **Notes**: Default implementations should be deny-by-default or mock-friendly. Shell execution must never bypass policy, approval, trace, output limits, or workspace boundaries.

### Task: Wire trace to an external sink (Datadog, Sentry, file)

- **Entry point**: `packages/core/src/storage.ts` (`TraceSink`)
- **Interface to implement**: `TraceSink` (`append` + optional `flush`)
- **Must read**: `docs/reference/PROTOCOL.md` (file trace section), ADR `0006-jsonl-traces-with-tiered-detail.md`
- **Must update on change**: nothing; `TraceSink` consumes the already-serialized event stream
- **Wire in via**: `run.events.subscribe(event => sink.append(event))`; flush at terminal state
- **Notes**: Apply trace-level filtering and redaction before forwarding; do not rely on the downstream system to redact. For local derived analytics, prefer `summarizeTraceJsonl` / `summarizeTraceFile` over maintaining a second mutable counter path. Use `validateSessionTraceConsistency` for session directory integrity checks.

### Task: Add lazy / deferred tool discovery (`tool_search`)

- **Entry point**: `packages/core/src/tool-search.ts`
- **Interface to consume**: `createToolSearchTool({ source })` + `toolSearchSourceFromRegistry(registry)`
- **Must read**: `packages/core/src/tools.ts` (look for `deferLoading` / `alwaysLoad`)
- **Must update on change**: nothing in schemas; this is a runtime-only surface
- **Wire in via**: register the resulting `ToolDefinition` with your `ToolRegistry` so the model can call `tool_search` to fetch deferred tool schemas on demand
- **Notes**: Tools declared `deferLoading: true` should be hidden from the initial prompt by the host's prompt builder. The host inserts returned schemas into the next turn's tool list.

### Task: Detect prompt-cache breakage

- **Entry point**: `packages/core/src/cache-break.ts`
- **Interface to consume**: `wrapPromptBuilderWithCacheBreakDetector(builder, { events })`
- **Must read**: README "Loop invariants worth knowing before extending"
- **Must update on change**: nothing; the detector is read-only
- **Wire in via**: pass the wrapped builder as `createRun({ promptBuilder })`
- **Notes**: Emits `context.cache_break.detected` (dev/debug trace) when a previously-stable prefix message changes between turns. Provider adapters that need cache-control blocks should consume `compilePromptCacheBlocks(prompt)` from `packages/core/src/context.ts` rather than re-deriving stable/session/turn boundaries. Zero behavioral impact.

### Task: Fork a session from a specific event

- **Entry point**: `packages/core/src/session.ts` (`forkSessionFromEvent`)
- **Interface to consume**: `forkSessionFromEvent({ sourceSessionId, forkAtSequence, store })`
- **Must read**: ADR / `docs/reference/PROTOCOL.md` (session events)
- **Wire in via**: call after deciding to branch; pass the returned `forked.id` to subsequent `createRun({ ... })` calls
- **Notes**: Source events are replayed verbatim with new ids and re-numbered sequences. Useful for AI-debugging "what if I'd stopped here" investigations.

### Task: Run user-configurable hooks (settings.json-style)

- **Entry point**: `packages/core/src/user-hooks.ts`
- **Interface to implement**: `UserHookRunner`
- **Wire in via**: `bindUserHooks({ events: run.events, runner })`
- **Notes**: Core defines the trigger vocabulary (`UserHookTrigger`) and forwards matching events; the host owns execution (shell, webhook, file write). Failures are recorded as `user_hook.failed` events and never abort the run.

### Task: Spawn a background task from a run (Task\*)

- **Entry point**: `packages/agent-runtime/src/tasks/` (`TaskManager`, `InMemoryTaskStore`, `createTaskCreate`, `createTaskControl`)
- **Interface to implement**: `TaskStore` (durable backends), `TaskRunner` (kind-specific runners)
- **Wire in via**: register the five `task_*` `ToolDefinition`s with your `ToolRegistry`; call `TaskManager.registerKind(kind, runner)` for each runner the model can spawn
- **Notes**: Tasks are NOT new runs — they are work spawned BY a run that the model can poll / cancel / stream output from. Emits `task.*` lifecycle events.

### Task: Add a sandboxed shell tool

- **Entry point**: `packages/shell-tool/src/`
- **Interface to consume**: `createShellTool({ environment, ... })`
- **Must read**: `packages/shell-tool/README.md`, `packages/shell-tool/src/destructive-patterns.ts`
- **Wire in via**: register the returned `ToolDefinition` and configure your `Policy` to honor its `requiresApproval` flag
- **Notes**: Three-tier safety (allow / require_approval / deny). Destructive commands (`rm -rf /`, fork bomb, curl | sh, etc.) are denied even with approval.

### Task: Load and match skills

- **Entry point**: `packages/skills/src/`
- **Interface to consume**: `loadSkillsFromDirectory(dir)`, `SkillRegistry`, `matchSkills(query, skills)`
- **Must read**: `packages/skills/README.md`
- **Wire in via**: project loaded skills via `skillsToCapabilities(...)` into the core `CapabilityRegistry`, or splice skill instructions into your `ContextAssembler`
- **Notes**: Deterministic keyword-overlap matcher (no embeddings). Per-file load errors are non-fatal and surfaced via `loadErrors[]`.

### Task: Set or change the agent's system prompt / identity

- **Entry point**: the per-shell identity string lives at the `createRun` call site — `packages/cli/src/cli.ts` (the `appPrompt` const). The builder that places it is `buildAgentPromptBuilder` in `packages/project-context/src/index.ts`.
- **Interface to consume**: `buildAgentPromptBuilder({ cwd, appPrompt? })` returns a `PromptBuilder`. For a standalone section, `createAppPromptSection(text)` (in `packages/core/src/context.ts`).
- **Must read**: `docs/reference/CONTEXT_PLANE.md` ("Prompt-Cache Invariant", "Section Cache Policy And Stability")
- **Wire in via**: `createRun({ promptBuilder: buildAgentPromptBuilder({ cwd, appPrompt }) })`
- **Notes**: `appPrompt` renders as the `app_identity` section inside the **stable** cache prefix (after the resident harness contracts, before tool descriptors) — safe to cache, so put durable identity here, not per-turn data. Omit `appPrompt` to skip the section entirely. Local and compatible project instruction files are auto-discovered from `cwd` and land in a `session`-cached `project_instructions` block; environment (cwd/platform/day-granularity date) lands in the `turn` tail. `host` intentionally leaves `appPrompt` empty so the identity can be injected by the embedding layer; `cli` sets a default in `cli.ts`.

---

> Note: some interfaces (`RunStore`, `TraceSink`, `MemoryStore`, `Compactor`, `SessionStore`) are introduced in v0.1; see those files for the canonical shape. `RunStore` is now wired through `createRun({ runStore })`; the remaining wiring points (e.g. `TraceSink`, `Compactor`) are still embedder-attached via `run.events.subscribe(...)`.
