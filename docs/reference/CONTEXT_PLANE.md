# Context Plane

This is a reference contract. If you are new to Sparkwright, start with
[the documentation map](../README.md) or the [Capability Design Guide](../guides/CAPABILITY_DESIGN_GUIDE.md).

The Context Plane is the replaceable part of Sparkwright that decides what the model sees and how that material is packaged.

It should be decoupled from the run loop, provider adapters, memory stores, and tool execution. Context technology changes quickly; the core should define protocols and lifecycle hooks, not hard-code one strategy.

## Design Goal

Sparkwright core should own:

- context item protocol
- context lifecycle points
- traceable selection records
- stable handoff to model adapters

Replaceable Context Plane implementations should own:

- which context sources to consult
- which items to include
- how to budget and order items
- how to summarize or compact
- how to load skills
- how to reference artifacts
- how to format model-facing messages

## Boundary

The run loop asks the Context Plane for selected context before each model call.

```txt
run step
  -> collect runtime state
  -> ContextAssembler selects context
  -> PromptSection builders render prompt layers
  -> PromptBuilder packages sections
  -> ModelAdapter calls provider
  -> tool results and artifacts become future context sources
```

The run loop should not know whether context came from files, memory, retrieval, skills, artifacts, or summaries.

## Main Components

### ContextSource

A source that can provide context candidates.

Examples:

- initial user context
- workspace files
- tool observations
- artifacts
- run summaries
- skill descriptors
- loaded skill files
- project memory
- external retrieval systems

### ContextAssembler

Selects the context items for a model turn.

Responsibilities:

- gather candidates from sources
- rank by relevance and priority
- enforce budget limits
- prefer summaries and references for large outputs
- preserve required items
- emit traceable selection metadata

### ContextBudgeter

Controls how much context can be included.

The first implementation can use character counts. Later implementations can use provider token counters or model-specific budget estimates.

Budgeting should account for:

- model context limit
- reserved output tokens
- tool definitions
- resident prompt
- selected context
- provider-specific overhead

### ContextCompressor

Shrinks old or large context while preserving important information.

Compression strategies may include:

- truncation
- rule-based summaries
- LLM summaries
- branch summaries
- artifact references
- observation masking

Compression is optional in v0.

#### Cost-aware compaction

Compaction decisions can be driven by live spend, not just character/token
budgets. The run loop projects the `UsageTracker` snapshot into
`ContextHints.usage` (a `ContextUsageHint`: accumulated input/output/total
tokens, `costUsd`, `modelCalls`, the last call's `lastInputTokens`, and a
derived `contextWindowPressure` in `[0,1]` computed from `lastInputTokens`
against the active model's `contextWindowTokens`). Every compaction stage
receives this on `input.hints.usage`, closing the loop between cost
observability and context optimization.

`gateStageByUsage(stage, thresholds)` wraps any stage so it runs only once
usage clears `minContextWindowPressure` / `minCostUsd` / `minTotalTokens`
(logical AND). This is the canonical way to defer an expensive model-backed
summarizer until the window is genuinely near full, or to cap spend on a
long-running run. Reactive overflow recovery (`input.reactive === true`)
bypasses the gate, since the model already reported the context is too large.
A missing `usage` never opens a cost gate — cost-aware compaction is
intentionally conservative and waits for measured pressure.

### SkillLoader

Loads optional knowledge on demand.

The resident context should include only skill descriptors. A SkillLoader can load full skill files when descriptors match the task.

Skill loading should be traceable because loaded skills influence model behavior.

### ObservationFormatter

Turns tool results, errors, validations, and approvals into compact model-readable observations.

It should avoid feeding large raw outputs directly into model context. It can store full results as artifacts and return summaries with artifact references.

Observation formatting must preserve decision-critical structure. Compression is
only helpful when the model can still tell whether it has enough information to
answer or what exact follow-up action can recover the missing detail. In
particular:

- Small lists of scalar values that are themselves the answer surface, such as
  `glob.paths`, should remain intact when they fit the observation budget.
- Error blocks, exit status, failure summaries, and validation findings should
  be preserved ahead of low-value successful output.
- A compressed observation must be explicit about incompleteness
  (`truncated`, `hasMore`, `nextOffset`, `cursor`, or an artifact reference). Do
  not present a preview as if it were a complete result.
- Large raw outputs should have a recovery path: artifact id/path, pagination,
  or a specific follow-up tool. Otherwise the model may repeatedly call the
  same tool trying to obtain content the formatter already discarded.

This is the Sparkwright version of RTK-style output governance: reduce noise,
but keep failures, paths, diagnostics, and recovery handles actionable. The
formatter should optimize for answerability before token savings.

### PromptBuilder

Packages selected context into provider-facing input.

PromptBuilder is separate from ContextAssembler:

- ContextAssembler decides what to include.
- PromptBuilder decides how to present it.

This separation keeps provider-specific packing out of context selection.

### PromptSection

`PromptSection` is a finer-grained composition unit than `PromptBuilder`.
The builder owns ordering and assembly; each section owns one named slice of
model-facing text.

Good section candidates:

- resident harness instructions
- tool descriptors
- skill index summaries
- runtime state
- selected context
- capability delta summaries

Sections make cache policy and observability explicit. A provider-neutral
builder can attach `sectionName`, `layer`, and `cachePolicy` metadata before
provider adapters translate the neutral prompt into an API-specific request.

## Proposed Interfaces

These interfaces are partially implemented in `@sparkwright/core` as the first Context Plane slice. They are still early and may evolve as provider adapters and repo-pilot exercise them.

```ts
export type ContextLayer =
  | "resident"
  | "capability"
  | "skill_index"
  | "runtime"
  | "working"
  | "memory"
  | "artifact";

export type ContextStability = "stable" | "session" | "turn";

export interface ContextBlock {
  id: string;
  layer: ContextLayer;
  stability: ContextStability;
  priority: number;
  content: string;
  source?: {
    kind: string;
    path?: string;
    uri?: string;
  };
  metadata: Record<string, unknown>;
}

export interface ContextAssemblyInput {
  run: RunRecord;
  step: number;
  goal: string;
  events: SparkwrightEvent[];
  priorContext: ContextItem[];
  budget?: ContextBudget;
}

export interface ContextAssemblyResult {
  items: ContextItem[];
  omitted: Array<{
    source: string;
    reason: string;
  }>;
  metadata: Record<string, unknown>;
}

export interface ContextAssembler {
  assemble(
    input: ContextAssemblyInput,
  ): Promise<ContextAssemblyResult> | ContextAssemblyResult;
}
```

PromptBuilder can target a neutral message shape first:

```ts
export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  stability?: ContextStability;
  metadata?: Record<string, unknown>;
}

export interface PromptBuildInput {
  run: RunRecord;
  step: number;
  tools: ToolDescriptor[];
  context: ContextItem[];
}

export type PromptSectionCachePolicy =
  | "stable"
  | "session"
  | "turn"
  | "volatile";

export type PromptSectionBuildResult =
  | string
  | PromptMessage
  | null
  | undefined;

export interface PromptSection {
  name: string;
  order?: number;
  role?: PromptMessage["role"];
  layer?: ContextLayer;
  stability?: ContextStability;
  cachePolicy?: PromptSectionCachePolicy;
  volatileReason?: string;
  build(
    input: PromptBuildInput,
  ): Promise<PromptSectionBuildResult> | PromptSectionBuildResult;
}

export interface SectionedPromptBuilderOptions {
  sections: PromptSection[];
}

export interface PromptBuilder<TOutput = PromptMessage[]> {
  build(input: PromptBuildInput): Promise<TOutput> | TOutput;
}
```

Provider adapters can then convert neutral prompt messages into the specific input shape each hosted API, AI SDK, gateway, or local model expects.

## Default v0 Strategy

The default v0 Context Plane should be intentionally simple.

### DefaultContextAssembler

Include:

- initial context passed to `createRun`
- compact runtime context: goal, step, run state
- recent tool result observations
- recent validation failures when available
- artifact references instead of large artifact content

Exclude:

- full trace
- full artifact content
- long raw tool outputs
- long-term memory
- vector retrieval
- every file in the workspace

Limits:

- max recent observations
- max characters per observation
- max total selected context characters

### DefaultPromptBuilder

The reference prompt builder is sectioned. Default section order:

1. Stable resident harness rules.
2. Tool descriptors and capability summary.
3. Runtime goal and state.
4. Selected context.
5. Additional extension sections, ordered by `order` and then `name`.

The stable prefix should keep deterministic ordering and formatting.

`buildAgentPromptBuilder` (in `@sparkwright/project-context`) is the reference composition of slot 5 for product shells: an optional `app_identity` section (`createAppPromptSection`, rides the stable prefix), an auto-discovered `project_instructions` section (`session`-cached), and an `environment` section (`turn` tail). See `docs/maintainer/AI_TASK_INDEX.md` → "Set or change the agent's system prompt / identity".

## Section Cache Policy And Stability

Prompt sections should declare how often their bytes are expected to change:

- `stable`: provider-neutral harness text or tool schemas that should remain
  byte-identical across turns and, when possible, across sessions.
- `session`: material fixed for one run or session, such as a selected agent
  profile, resolved skill index snapshot, or MCP server inventory snapshot.
- `turn`: material rebuilt for each model call, such as runtime state, selected
  context, recent observations, or goal-specific capability notes.
- `volatile`: material expected to change frequently or nondeterministically.
  A volatile section must include `volatileReason` so trace readers and cache
  accounting can explain why it was intentionally kept outside stable cache
  assumptions.

`ContextItem.metadata.stability` currently uses `stable`, `session`, or
`turn`. `PromptSection.cachePolicy` adds `volatile` for rendered prompt slices
that are deliberately high-churn.

Dynamic capability lists should avoid rewriting stable tool schema blocks. If
Skills, MCP servers, hosted tools, or agent-scoped capabilities change during a
session, represent the change as session/turn context or as a capability delta
section. Keep the stable tool descriptor section for durable schemas and append
or replace only the dynamic layer.

The reference `DefaultPromptBuilder` follows this rule by splitting resident
instructions into stable sections, rendering eager tool descriptors as
`session` capability material, and rendering deferred tool inventory as a
volatile `capability_delta` section. Provider adapters can call
`compilePromptCacheBlocks(prompt)` to translate those neutral messages into
provider-specific cache blocks without re-deriving section order or cache
policy.

## Prompt-Cache Invariant (must-read for extensions)

Every major model provider that offers prompt caching keys the cache on
byte-identical prefixes of the request. If a
later turn re-sends a `PromptMessage` whose content differs by even one
character from what was sent before — formatting tweak, regenerated
timestamp, reordered metadata, anything — the entire cached prefix is
invalidated and the provider re-bills the user.

The Context Plane must therefore treat `PromptMessage`s with
`stability: "stable"` (and the `ContextItem`s that produce them) as
**append-only and never edited in place**.

Operational rules for any extension that touches context:

1. **Resident layer is immutable per session.** Items in the `resident`
   layer must not be re-emitted with different content on subsequent turns.
   Add new resident facts as separate items at the end, never by editing
   earlier ones.
2. **Stable messages keep byte order.** `PromptBuilder` implementations
   must emit `stable` messages in the same order across turns. If a tool
   was registered after step 3, do not retroactively reorder its descriptor
   into the original tool block — append it as a new stable message at the
   tail.
3. **Dynamic capabilities are deltas.** Skills, MCP inventories, and
   agent-scoped capability lists that change during a run should be rendered as
   `session` or `turn` context, or as a dedicated capability delta section.
   Do not rebuild the stable tool schema block just to reflect a changing
   availability list.
4. **Compaction rewrites are turn-scoped.** A compactor may delete or
   replace `turn` and `session` items freely, but cannot rewrite the
   `resident` prefix. If a `Compactor` resets the resident layer, treat
   that as an explicit cache reset and emit
   `context.compaction.completed { resetsPromptCache: true }`.
5. **Backfilling is opt-in.** If an extension wants to enrich a tool result
   in place (e.g. attach a model-derived summary to an earlier tool_result
   block), it must clone the item and yield the modified copy downstream —
   leaving the original byte-identical in the prompt history.
6. **Recovery messages are appended.** The `model_recovery` continuation
   note (see `core/src/run.ts: makeContinuationContextItem`) is added as a
   NEW `user` ContextItem after the truncated assistant turn. The harness
   never edits the truncated message.

If you must violate one of these rules, document the cache-invalidation
event in the trace via `context.compaction.completed
{ resetsPromptCache: true }` so cost accounting can be reconciled.

## Events

Context selection should be observable.

Current and candidate event types:

- `context.assembled`
- `context.compaction_requested`
- `context.item.included`
- `context.item.omitted`
- `context.compacted`
- `skill.loaded`
- `prompt.built`

v0 emits `context.assembled` for every context assembly and `context.compaction_requested` when budget pressure causes truncation or omission. It does not perform LLM compaction yet.

## Relationship To Provider Adapters

Provider adapters should not decide what context matters.

They may decide how to format selected context for a specific API:

- OpenAI-compatible messages and tools
- alternative hosted-API system and messages shapes
- AI SDK `generateText` or `streamText` input
- gateway / proxy inputs (LiteLLM, OpenRouter-style)
- OpenRouter model input

When a provider supports prompt caching, adapters should preserve the compiled
stable prefix and keep `session`, `turn`, and `volatile` blocks outside that
prefix. Dynamic capability inventories, MCP snapshots, and skill listings
should not be merged into stable resident instructions.

Model capabilities can influence assembly:

- context window size
- tool-call support
- reasoning support
- prompt caching support
- multimodal support

That influence should flow through model metadata, not provider-specific conditionals inside the core run loop.

## Relationship To Memory

Memory is a ContextSource, not the Context Plane itself.

Sparkwright should support memory later without making memory mandatory:

- no memory for v0
- file memory or run summaries for v1
- external stores and vector retrieval later

Memory items should be traceable when loaded and should not be treated as authoritative facts without verification.

## Relationship To Artifacts

Artifacts are evidence. Context often needs only references.

The Context Plane should prefer:

```txt
artifact id + path + summary + why it matters
```

over:

```txt
entire artifact content
```

Full artifact content should be loaded only when a task explicitly needs it.

## Roadmap

### v0

Current progress:

- `ContextAssembler` and `PromptBuilder` interfaces exist.
- `PromptSection`, `SectionedPromptBuilder`, and section cache policy metadata exist.
- `DefaultContextAssembler` exists with simple character budgets and omission metadata.
- `DefaultPromptBuilder` exists with stable-before-dynamic neutral messages.
- `DefaultObservationFormatter` exists for compact tool-result observations.
- `context.assembled` and `prompt.built` events exist.

Remaining v0 work:

- done: exercise Context Plane through the deterministic repo-pilot flow
- done: emit compact context assembly and prompt-building events in the run loop
- pending: reference artifacts instead of embedding large content
- pending: further harden context assembly trace payloads

### v1

- skill descriptors and SkillLoader
- provider-aware budget estimates
- compact summaries
- observation store
- filesystem-backed context references
- validation feedback formatting

### Later

- vector retrieval
- project memory
- branch summarization
- subagent summary ingestion
- provider-specific prompt caching hints
- semantic compression
- replay-assisted context reconstruction

## Non-Goals For v0

- full RAG pipeline
- long-term memory system
- LLM compaction
- automatic skill authoring
- multi-agent context sharing
- provider-specific prompt optimization beyond stable ordering

The v0 goal is to make context selection explicit, bounded, and replaceable.
