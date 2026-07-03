# Changelog

All notable changes to Sparkwright will be documented in this file.

## Unreleased (target: v0.1.0)

### Fixed

- Per-token `model.stream.chunk` events used to flood both the CLI
  terminal output and the persisted `trace.jsonl` at the default
  `standard` trace level — a short streamed answer produced 30+ chunk
  lines that obscured the rest of the run. The aggregated text is
  already on `model.stream.completed.payload.output.message`, so these
  high-frequency chunks now only render at `--trace-level debug`. New
  exported predicate `isVerboseStreamEvent(event)` is used by both
  `FileRunStore.append` and the CLI's stdout writer so the live event
  log and the file stay aligned.
- `@sparkwright/provider-ai-sdk` streaming adapter: provider/API failures
  (401, 429, 5xx, network errors) used to arrive as a `chunk.type ===
"error"` item on the AI SDK `fullStream` and were silently dropped by
  the adapter loop. The run then observed an empty model output, emitted
  `model.stream.completed` + `model.completed`, and terminated with
  `final_answer` and exit code 0 — visually indistinguishable from a
  successful read-only run. The adapter now re-throws those error chunks
  so the core run loop's stream catch emits `model.stream.failed` and
  fails the run visibly. Previously verified failure paths (timeouts,
  malformed tool arguments) were already handled correctly.

### Added

- External delegate capability descriptors now surface in host capability
  snapshots, CLI `capabilities inspect`, and the TUI capability panel. They
  report protocol (`acp` / `external_command`), approval requirement,
  process-spawn status, shell access, workspace access, command, timeout, and
  output limits. Delegate trace events now include structured failure codes
  and compact completion summaries such as exit code and output truncation
  flags.
- `workspace.write.skipped` event so idempotent edit tools can record
  "no-op" decisions on the trace and callers can distinguish "no write
  attempted" from "write attempted and applied". New
  `RuntimeContext.reportWorkspaceWriteSkipped({ path, reason? })` helper
  forwards to the run event log. The CLI `append_file` demo tool uses
  it when the requested heading is already present. Schema +
  PROTOCOL.md updated.
- CLI now prints a workspace mutation summary line after every run:
  `Workspace writes: N applied, M skipped (no-op), K denied.` or
  `No workspace changes were made (read-only run).` — so sucessful
  no-op runs no longer look identical to runs that mutated files.

- **Loop extension surface (v0.1 wave 2).** The reference run loop now
  exposes five new extension points, all additive and optional:
  - `CreateRunOptions.compactionStages: CompactionStage[]` — multi-stage
    compaction pipeline applied before each model call and reactively on
    `recoveryHint: 'reduce_input'`. New module `pipeline.ts`. Events:
    `context.compaction.started` / `.completed` / `.failed`.
  - `CreateRunOptions.prefetchers: ContextPrefetcher[]` — fires before the
    model call so Skill / Memory / MCP lookups overlap the LLM round-trip;
    results land in the NEXT turn's context. Errors swallowed and logged.
  - `CreateRunOptions.observationSummarizer: ObservationSummarizer` —
    async per-batch tool summary, awaited just before the next model call.
  - `CreateRunOptions.models: ModelAdapter[]` — fallback chain. Loop
    switches on `recoveryHint: 'fallback_model'`.
  - `ValidationStage` gains `pre_terminal` (blocks completion, injects
    continuation context — transition `stop_hook_blocked`) and
    `post_sampling` (fire-and-forget telemetry; see
    `kickPostSamplingHooks`).
- **AbortSignal vertical.** `RuntimeContext.abortSignal`,
  `ModelInput.abortSignal`, and `executeTool({ abortSignal })` all wired
  to a run-scoped `AbortController`. `cancel()` now trips the signal so
  mid-stream model calls and mid-execution tools that honor it tear down
  without waiting for the next loop boundary. New tool result status
  `cancelled`. New options: `CreateRunOptions.abortSignal` (external
  signal), `runHandle.abortSignal`.
- **Recoverable model errors.** Errors carrying
  `recoveryHint: 'reduce_input' | 'extend_output' | 'fallback_model'` (or
  HTTP 413 / `PROMPT_TOO_LONG` / `MAX_OUTPUT_TOKENS`) route through new
  `model_recovery` transitions instead of failing the run. Continuation
  notes injected as new `user` context items (cache-safe, never edits
  earlier messages). `CreateRunOptions.maxOutputRecoveries` (default 3).
- **Streaming pipe extensions.** `ModelOutputChunk` adds `stop` chunks
  (carries `stopReason`) and `tool_call_end.arguments` (pre-parsed
  arguments — provider can skip the join+JSON.parse path).
  `ModelOutput.stopReason` enumerated for downstream gating.
- **Loop decomposition.** `runLoop` is now phase-factored into
  `shapeContext`, `buildPromptPhase`, `callModelPhase`,
  `finalizeTurnContext`. Each phase has a clear pre/post-condition and is
  swappable in tests without subclassing.
- **New stop reasons / transitions.** `blocking_limit`,
  `stop_hook_prevented`. `RunLoopTransitionReason` documented and expanded
  to include `stop_hook_blocked`, `model_recovery`, `compaction_applied`,
  `fallback_model`.
- **Docs.** `README.md` gains an "Extension Map" table mapping each
  embedder intent to interface + file. `docs/reference/CONTEXT_PLANE.md` gains a
  "Prompt-Cache Invariant" section listing the rules every extension that
  touches context must follow.
- Extension protocol interfaces: `RunStore`, `TraceSink`, `MemoryStore`, `SessionStore`, `Compactor`, `ContextExtension`, `ToolExtension`. Reference implementations (`FileRunStore`, `MemoryTrace`) now `implements` the corresponding protocol.
- `@sparkwright/core/internal` subpath entry — explicit opt-in for the reference implementation classes (`SparkwrightRun`, `EventLog`, `FileRunStore`, `MemoryTrace`, `LocalWorkspace`, `ControlledWorkspace`, `DefaultContextAssembler`, `DefaultPromptBuilder`, `DefaultObservationFormatter`).
- Four extension events now actually emitted: `skill.indexed`, `skill.loaded`, `mcp.server.prepared`, `agent.profile.derived`. Threaded through skills/mcp-adapter/agent-runtime via `EventEmitter` / `BufferedEmitter`.
- Provider-neutral prompt section composition: `PromptSection`, `SectionedPromptBuilder`, `createDefaultPromptSections`, and `DefaultPromptBuilder({ additionalSections })` let embedders add named prompt layers with `stable` / `session` / `turn` / `volatile` cache policy metadata. `prompt.built` now reports section names, stability, cache policy, and character counts.
- Protocol versioning: every JSON Schema now carries `$id` of `https://sparkwright.dev/schemas/v0/<name>` and `"x-sparkwrightProtocolVersion": "0.1"`. Evolution tracked in `docs/reference/PROTOCOL_CHANGELOG.md`.
- Protocol consistency gate in `scripts/validate-schemas.mjs`: diffs `EventType` / `RunStopReason` against schema enums and round-trips PROTOCOL.md tokens.
- `docs/maintainer/AI_TASK_INDEX.md` for AI-agent–oriented task → entry-point lookup. ADR 0003-0006 (anchored edits, approval-gated writes, deterministic default model, JSONL trace tiers).
- `@reserved` JSDoc convention + `scripts/check-reserved-fields.mjs` scanner. Run via `npm run check:reserved`.

### Fixed

- Workspace path containment now resolves symlinks via `fs.realpath`, closing a sandbox escape where a symlink inside the root could point outside.
- Doom-loop counter now accumulates within a single step (previously only across steps); limit configurable via `CreateRunOptions.doomLoopRepeatLimit`.
- Streaming `JSON.parse` of tool-call arguments is now safe — malformed JSON terminates the run with `model_output_invalid` (non-retryable) instead of being retried as a network error.
- Approval-driven workspace state transitions route through `SparkwrightRun.setState`, restoring legal-transition validation.

### Changed

- `@sparkwright/agent-runtime` `InMemoryTaskNotificationQueue` bounded
  capacity semantics changed for reliable task notifications. When
  `maxBufferedNotifications` is set, lossy actor notifications may still be
  dropped under capacity pressure, but reliable terminal task notifications are
  no longer evicted by drop-oldest behavior. If the queue cannot make room, it
  throws retryable `ACTOR_INBOX_CAPACITY` instead. Migration: embedders that
  relied on drop-oldest for terminal task notifications should either leave the
  queue unbounded, increase the capacity, drain terminal notifications more
  aggressively, or handle the retryable capacity error through their
  `TaskManager` sink error/retry path.
- External ACP and external-command delegates no longer receive direct project
  workspace access by default. Delegates run from an isolated temporary cwd and
  `{{workspaceRoot}}` / configured `cwd` are rejected unless the profile
  metadata explicitly sets `"workspaceAccess": "read_write"`. This is a
  safety-oriented migration: existing external reviewers that intentionally
  inspect or mutate the workspace must opt in with that field.
- `packages/core/src/index.ts` reorganized with explicit PUBLIC / IMPLEMENTATION sections. Reference implementation classes are tagged `@internal` and remain re-exported from the top-level entry for backward compatibility. In a future minor release they will be removed from the top-level entry — depend on them via `@sparkwright/core/internal` and pin a minor version.
- `packages/core` and `packages/cli` no longer ship `src` in npm `files` — only `dist`. This closes the deep-path import bypass.
- `packages/cli` no longer exposes a library entry (`exports` / `main` / `types` removed). It is a `bin` only.

## 0.1.0 - 2026-05-17

### Added

- Runnable deterministic CLI golden path with durable JSONL traces.
- Core runtime primitives for runs, events, tools, policy, approvals, workspace writes, artifacts, and context assembly.
- Approval-gated workspace write path with diff artifacts and changed-file conflict detection.
- Trace levels, run storage, and default redaction for common secret keys and token-shaped values.
- AI SDK provider edge, optional OpenAI CLI path, OpenAI-compatible base URLs, and proxy environment support.
- Custom tool example, troubleshooting guide, protocol schemas, and v0 release checklist.
- Schema validation wired into the shared local and CI release gate.
- Worklog convention for recording why meaningful AI-native development changes were made.

### Deferred

- Streaming providers, replay, provider registry, trace viewer, advanced retrieval/memory, and non-CLI integrations.
