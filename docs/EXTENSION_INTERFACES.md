# Extension Interfaces

This document explains how applications and extension authors should connect optional capabilities to Sparkwright core.

Sparkwright core is intentionally small. Extensions should make agents more capable without bypassing the runtime boundary that makes runs inspectable, controllable, and recoverable.

## Interface Principle

Extensions should converge into existing core primitives:

```txt
External capability
  -> ContextItem or ToolDefinition
  -> policy and approval
  -> trace and artifacts
  -> run result
```

The run loop should not need to know whether a capability came from a Skill, MCP server, memory store, hosted worker, local script, or product-specific integration.

## Core Guarantees

Applications and extensions can rely on core to provide:

- run lifecycle and terminal state handling
- model adapter boundary
- context assembly protocol
- prompt building boundary
- tool registration and argument validation
- tool execution lifecycle
- policy decisions
- approval requests
- workspace read and write boundaries
- validation hooks
- trace events
- artifact references
- structured failures and stop reasons

Extensions should use these guarantees instead of reimplementing them.

## Extension Rules

Extensions must not:

- mutate run state directly
- execute side effects outside the governed tool path
- bypass policy or approval
- hide workspace writes inside context loading
- inject large raw outputs directly into prompt context
- treat memory, retrieval, or Skill text as authority
- assume a specific provider message format inside core-facing code
- require the core run loop to understand extension-specific protocols
- fork the run loop to inject prompts, tools, Skills, MCP, or agents

Extensions should:

- expose explicit metadata about capability origin
- keep large outputs as artifacts where possible
- preserve source references for audit and replay
- return structured errors
- keep deterministic logic in code instead of long prompt instructions when practical
- make risky actions visible to policy and approval
- register a `PromptSection` or produce `ContextItem` values when they need to influence model input

## Context Extensions

Use context interfaces when an extension provides information to the model.

Good candidates:

- Skills
- memory
- retrieval
- MCP resources
- files selected by a product shell
- run summaries
- artifact summaries

Recommended shape:

```ts
interface ContextExtension {
  name: string;
  describe():
    | Promise<ContextExtensionDescriptor[]>
    | ContextExtensionDescriptor[];
  load(
    input: ContextExtensionLoadInput,
  ): Promise<ContextItem[]> | ContextItem[];
}
```

These interfaces are now exported from `@sparkwright/core` (see `packages/core/src/extensions.ts`). Implementations still feed core through `ContextItem[]` passed to `createRun({ context })` or a custom `ContextAssembler`; the interface is a type-level contract, not a new runtime entry point.

### Project Instruction Files

Project-local instruction files are an edge concern, not a core concern.
Use `@sparkwright/project-context` when a host wants to load repository rules
from local and compatible project-instruction files.

The package keeps core cache-friendly by returning `session`-stability
`ContextItem` values instead of editing resident prompt text. Discovery is
priority-based: Sparkwright-owned files are searched upward to the git root,
then compatible files are checked in the current directory. Hosts can pass
`ignoreProjectInstructions: true` for tests, benchmarks, trajectory capture, or
other reproducible runs.

Directory-specific hints should be appended to tool observations with
`loadSubdirectoryInstructionHint()` when a workspace tool enters a new
directory. That gives the model timely local context without rebuilding the
stable system prompt.

Each context item should include:

- a stable `source`
- `metadata.layer`
- `metadata.stability`
- enough metadata to explain origin and selection

Example:

```ts
const context: ContextItem[] = [
  {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "skill",
      path: "skills/dingtalk-notifier/SKILL.md",
    },
    content: skillBody,
    metadata: {
      layer: "skill_index",
      stability: "session",
      skillName: "dingtalk-notifier",
      version: "1.0.0",
      contentHash: "sha256:...",
    },
  },
];
```

## Prompt Section Extensions

Use `PromptSection` when an extension owns a repeatable slice of prompt
assembly rather than a pool of context candidates.

Good candidates:

- resident harness additions
- stable tool descriptor blocks
- session-level skill or MCP inventories
- runtime state fragments
- selected context renderers
- capability delta summaries

`PromptSection` is smaller than `PromptBuilder`: a builder orders and packages
many sections, while a section renders one named layer. Prefer adding a
section over replacing the whole prompt builder when the extension only needs
one layer.

Recommended shape:

```ts
const skillIndexSection: PromptSection = {
  name: "skill_index",
  order: 30,
  role: "system",
  layer: "skill_index",
  stability: "session",
  cachePolicy: "session",
  build(input) {
    return renderSkillIndex(input.context);
  },
};
```

Section cache policy should be explicit:

- `stable`: byte-identical harness text or durable tool schemas.
- `session`: fixed for one run or session.
- `turn`: rebuilt for each model call.
- `volatile`: expected to change frequently; must include `volatileReason`.

Dynamic Skills, MCP server inventories, and agent-scoped capability lists should
be rendered as `session` or `turn` context, or as a capability delta section.
Do not frequently rewrite the stable tool schema section to represent changing
availability. Stable tool schemas are for durable descriptors; dynamic
availability belongs in a separate layer.

Wire sections through `new DefaultPromptBuilder({ additionalSections })` or a
custom `SectionedPromptBuilder`. If an extension only has data, not rendering
logic, produce `ContextItem` values and let the active prompt builder render
them.

## Tool Extensions

Use tool interfaces when an extension can perform an action.

Good candidates:

- MCP tools
- local scripts
- hosted tools
- product integrations
- shell-like capabilities
- workflow actions

Recommended shape:

```ts
interface ToolExtension {
  name: string;
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
}
```

Today, extension authors should normalize external capabilities into `ToolDefinition`:

```ts
const sendMessage = defineTool({
  name: "dingtalk.send_message",
  description: "Send a DingTalk group message.",
  inputSchema: {
    type: "object",
    properties: {
      webhookUrl: { type: "string" },
      message: { type: "string" },
    },
    required: ["webhookUrl", "message"],
    additionalProperties: false,
  },
  policy: {
    risk: "risky",
    requiresApproval: true,
  },
  interruptBehavior: "block",
  resultSize: {
    maxChars: 20_000,
  },
  governance: {
    sideEffects: ["network", "external"],
    dataSensitivity: "internal",
    idempotency: "non_idempotent",
    origin: {
      kind: "hosted",
      name: "dingtalk",
    },
  },
  async execute(args, ctx) {
    // Adapter-specific execution happens here.
    // Policy, approval, validation, timeout, and trace remain owned by core.
    return { ok: true };
  },
});
```

Tool origin should be carried in metadata where useful:

```ts
governance: {
  sideEffects: ["external"],
  audit: { level: "metadata" },
}
```

A future tool-origin field may distinguish `local:function`, `local:script`, `mcp:<server>`, and `hosted:<provider>`.

### Tool Result Presentation

Tool authors should design results for model answerability, not just for trace
fidelity. The model usually sees a compact observation, while the trace may
persist a fuller payload. If the observation hides the fields needed to decide
or answer, the agent can loop by re-running the same tool.

Guidelines for new tools:

- Return structured fields for the important facts (`paths`, `matches`,
  `errors`, `exitCode`, `hasMore`) instead of burying them in prose.
- Make discovery/listing tools pageable or bounded, and report
  `truncated: true` plus `nextOffset`/`cursor` when the result is incomplete.
- Keep small scalar lists complete when they are the answer surface. A list of
  paths is often more valuable than a lossy preview.
- For shell-like tools, follow failure-focused output: preserve stderr, exit
  code, and failing sections before successful noise.
- Put large raw stdout, logs, diffs, screenshots, and generated content in
  artifacts when possible, and return the artifact reference in the result.
- If a tool cannot support a common input shape (for example, `read_file` with a
  glob path), reject it with a targeted error and name the correct discovery
  tool instead of returning a generic missing-file error.

Future tool metadata may make this explicit with a result-presentation contract
(`kind`, fields to preserve, artifact policy, pagination field names). Until
then, treat these guidelines as part of the tool contract.

## Policy Extensions

Use policy interfaces when an application needs custom permission logic.

Policy extensions should decide whether an action is allowed, denied, or requires approval based on structured inputs.

Common policy inputs:

- tool name
- tool risk
- workspace path
- side effects
- agent id or role
- selected Skills
- MCP server origin
- data sensitivity
- project configuration
- user role

Policy should not depend on prompt wording alone. Skill `allowed-tools` metadata can inform policy, but it is not permission by itself.

## Approval Extensions

Use approval interfaces when a risky action needs human or external confirmation.

Approval brokers can be implemented by:

- CLI prompt
- desktop UI
- web callback
- Slack or Feishu bot
- GitHub comment
- CI gate
- enterprise workflow

Approval requests should remain serializable and traceable.

## Trace Extensions

Trace should explain why a run behaved the way it did.

Any extension that affects model input, tool availability, permission boundaries, or external side effects should leave traceable metadata.

Examples:

- selected Skill name and content hash
- memory item ids selected for context
- retrieval query and source references
- MCP server that provided a tool
- agent id that requested a capability
- approval request and response ids
- artifact ids for large outputs

The first implementation can store extension metadata on run metadata or existing events. First-class event types should be added when an extension becomes stable enough to standardize.

## Skill Extensions

Skills should enter as context first.

Near-term adapter shape:

```ts
const prepared = await prepareSkillsForRun({
  goal,
  skillRoots: ["./skills"],
});

const run = createRun({
  goal,
  context: prepared.context,
  tools: [...normalTools, ...prepared.tools],
  metadata: {
    loadedSkills: prepared.loadedSkills,
  },
});
```

Core does not need a `skills` option until the selection and loading behavior proves stable.

Skill scripts should be exposed as governed tools before execution. They should not run as an incidental side effect of reading `SKILL.md`.

Skill indexes and selected Skill bodies should normally be `session` or `turn`
context, or a dedicated `skill_index` prompt section. A Skill package should
not rewrite the stable tool schema block just because the matching set changes
for a new turn.

## MCP Extensions

MCP should enter as tools or context resources.

Recommended adapter flow:

```txt
discover MCP server
  -> list MCP tools and resources
  -> map tools to ToolDefinition
  -> map resources to ContextItem candidates
  -> execute through Sparkwright tool path
```

Core should not depend on MCP protocol details. An MCP adapter package can own connection lifecycle, protocol translation, and server-specific errors.

Changing MCP capability inventories should be reported as context or capability
delta sections. Keep stable tool schemas for descriptors that remain
byte-identical; expose newly discovered or temporarily unavailable capabilities
through `session`/`turn` material instead of rebuilding the stable prefix.

`@sparkwright/mcp-adapter` also exposes a minimal static bridge for resources
and prompt-like descriptors:

```ts
const context = normalizeMcpContextDescriptors([
  {
    serverName: "docs",
    uri: "file:///repo/README.md",
    text: "# Project notes",
  },
  {
    kind: "prompt",
    serverName: "playbooks",
    name: "review",
    messages: [{ role: "user", content: "Review this change." }],
  },
]);
```

The helper returns ordinary `ContextItem[]` with metadata including
`origin: "mcp:<server>"`, `sourceUri`, and `contentHash`. This keeps core free of
MCP protocol types while leaving a stable adapter surface for future live
`resources/list`, `resources/read`, and `prompts/get` integration.

## Multi-Agent Extensions

Multi-agent support should be agent-scoped from the beginning.

The current agent profile shape lives in `@sparkwright/agent-runtime`:

```ts
// shape mirrors @sparkwright/agent-runtime AgentProfile, see packages/agent-runtime/src/index.ts
interface AgentProfile {
  id: string;
  name?: string;
  description?: string;
  experimental?: {
    mode?: "primary" | "child" | "all";
    model?: unknown;
    prompt?: string;
  };
  mode?: "primary" | "child" | "all"; // @reserved v0.2
  model?: unknown; // @reserved v0.2
  prompt?: string; // compatibility fallback; prefer experimental.prompt
  allowedTools?: string[];
  deniedTools?: string[];
  policy?: CapabilityRule[];
  maxSteps?: number;
  runBudget?: RunBudget;
  metadata?: Record<string, unknown>;
}
```

Skill and MCP-server scoping is layered above this profile (see
`SkillAccessPolicy` in `@sparkwright/skills`); future versions may absorb
`allowedSkills` / `allowedMcpServers` into the profile itself.

Each agent should have explicit context, tools, policy, and trace attribution. Avoid implicit global Skills or tools shared by every agent.

Early multi-agent orchestration can live outside core by composing runs or child runs. Core should only absorb multi-agent primitives after trace, budgeting, cancellation, and parent-child semantics are clear.

Agent profiles that affect prompt behavior should become `ContextItem` values
or named prompt sections. Agent runtimes should compose runs or use child-run
helpers; they should not fork the core run loop to create a private prompt
path.

## Run Hooks

`RunHook` is the generic lifecycle-middleware seam for the run loop. Hooks
observe model and tool boundaries and may narrowly influence execution
without changing the loop itself.

Supported callbacks:

- `beforeModelCall(input)` — before each model invocation (with current
  prompt and assembled context). Observational.
- `afterModelCall(input)` — after the model produced output and usage was
  recorded.
- `beforeToolCall(input)` — before a tool is executed. May return
  `{ skip: { reason } }` to short-circuit the call into a `failed`
  `ToolResult` (the only supported in-loop mutation).
- `afterToolCall(input)` — after the loop emitted `tool.completed` /
  `tool.failed` for this call.
- `onEvent(input)` — synchronous event observer. Called for every event
  emitted by the run.
- `onError(input)` — called when a loop phase throws. Best-effort.

Errors thrown by a hook are caught, logged via `console.warn`, and surfaced
as a `hook.failed` event. They never abort the run.

Wire hooks via `createRun({ hooks: [...] })`. Hooks compose; use
`combineRunHooks([...])` if you need to merge them outside core.

```ts
const tracingHook: RunHook = {
  name: "otel-tracer",
  beforeModelCall: ({ runId, step }) => span.startChild({ runId, step }),
  afterToolCall: ({ result }) => span.recordToolResult(result),
  onEvent: ({ event }) => span.event(event.type, event.payload),
};
```

## Interaction Channel

`InteractionChannel` is the unified _outbound_ channel from the runtime to a
user (CLI prompt, desktop modal, Slack/Feishu DM, etc.). It generalizes
`ApprovalResolver` to also cover free-form questions and notifications.

```ts
interface InteractionChannel {
  approve?(request): Promise<ApprovalResponse>; // yes/no
  ask?(
    request: InteractionQuestionRequest,
  ): Promise<InteractionQuestionResponse>;
  notify?(notification: InteractionNotification): void | Promise<void>;
}
```

Wire via `createRun({ interactionChannel })`. When supplied,
`channel.approve` becomes the approval resolver (taking precedence over the
legacy `approvalResolver` option), and `RunHandle.askUser` /
`RunHandle.notifyUser` route through the channel.

Embedders that only implement approval today can keep using
`approvalResolver`; the channel is strictly additive. Use
`channelFromApprovalResolver` / `approvalResolverFromChannel` to bridge.

Every channel exchange emits `interaction.requested` / `interaction.resolved`
events so trace consumers see the full conversation, not just the binary
approval decision.

## Usage Tracker

`UsageTracker` aggregates per-run usage (tokens, model calls, tool calls,
wall time, cost, per-tool, per-model) and emits `usage.updated` events. The
default in-memory tracker is created automatically; supply your own to fan
out to a billing pipeline, dashboard, or external store.

```ts
const tracker = createUsageTracker({ runId });
const run = createRun({ ..., usageTracker: tracker });
tracker.subscribe((snapshot) => emitMetrics(snapshot));
```

`RunHandle.usage()` returns the current snapshot at any time.

## Commands

`CommandDefinition` and `CommandRegistry` are the _user-intent_ surface —
slash commands the user types into a CLI/desktop/bot. They are intentionally
distinct from `ToolDefinition`:

| Surface             | Caller    | Gate                          | Lifecycle            |
| ------------------- | --------- | ----------------------------- | -------------------- |
| `ToolDefinition`    | the LLM   | policy + approval + tool gate | inside a run         |
| `CommandDefinition` | the human | embedder-owned                | starts/mutates a run |

Commands MAY create runs, switch modes, fetch usage, or mutate session
state, but they MUST NOT bypass policy or approval if they cause risky
actions (use the same `createRun` and `requestApproval` paths).

```ts
const commands = new CommandRegistry();
commands.register({
  name: "compact",
  describe: "Compact the active run's context",
  run: async (ctx) => {
    // …trigger compaction on the active run…
    return { status: "ok", message: "context compacted" };
  },
});
await commands.dispatch("/compact aggressive");
```

## Sub-agents

Sub-agents (one run delegating a bounded sub-task to another) are layered
_above_ core. Core provides the primitives; the parent run is responsible
for the handoff shape.

Required contract for any sub-agent implementation (e.g. a future `AgentTool`
in the runtime package):

1. **Parent linkage.** The child run's `metadata.parentRunId` MUST be set to
   the parent's `RunRecord.id`. The child SHOULD set `metadata.spanId` so
   trace tooling can stitch nested spans.
2. **Policy inheritance.** The child run inherits the parent's policy by
   default (use `createLayeredPolicy([parentPolicy, childOverrides])`).
   Sub-agents MUST NOT silently widen permissions; any expansion must come
   from an explicit `childOverrides` layer.
3. **Approval channel.** The child run reuses the parent's
   `InteractionChannel`/`approvalResolver` unless the parent provides a
   sub-agent-specific channel. Approvals from a child are visible in the
   parent's trace via the `parentRunId` linkage.
4. **Usage rollup.** The parent SHOULD subscribe to the child's
   `UsageTracker` (`tracker.subscribe(...)`) and roll usage into its own
   tracker so the parent's `UsageSnapshot` reflects total cost.
5. **Trace nesting.** The child's events MUST flow through its own
   `EventLog`. The parent SHOULD emit a synthesized event (e.g. a tool
   result on the `AgentTool` call) carrying `childRunId` and a summary, not
   the raw child events, to avoid quadratic prompt growth.
6. **Cancellation.** Cancelling the parent MUST propagate to children. Wire
   the child run with `createRun({ abortSignal: parentRun.abortSignal })`.

Pseudocode:

```ts
async function runChildAgent(
  parent: RunHandle,
  goal: string,
): Promise<RunResult> {
  const child = createRun({
    goal,
    model: parentModel,
    policy: createLayeredPolicy([parentPolicy]),
    interactionChannel: parentChannel,
    abortSignal: parent.abortSignal,
    metadata: { parentRunId: parent.record.id, spanId: createId("span") },
  });
  // optional: forward child usage into the parent's tracker
  child.events.subscribe((event) => {
    if (event.type === "usage.updated") parentTracker.merge(event.payload);
  });
  return child.start();
}
```

### Reference implementation

`@sparkwright/agent-runtime` ships the runnable helpers that enforce this
contract. Use them directly rather than rewriting the wiring:

```ts
import {
  spawnSubAgent,
  createAgentTool,
  mountAgentTool,
} from "@sparkwright/agent-runtime";

// Low-level: build a child RunHandle under a parent.
const spawned = spawnSubAgent({
  parent,
  goal: "summarize the diff",
  model: childModel,
  tools: childTools,
  childAgentProfile, // optional, derives child policy
  parentUsageTracker, // optional, opts into rollup
  interactionChannel: null, // optional, suppress child user-interaction
});
const result = await spawned.run.start();

// High-level: register a ToolDefinition the parent's LLM can call.
mountAgentTool(parent, {
  buildSpawnInput: (input) => ({
    goal: input.goal,
    model: childModel,
    tools: childTools,
  }),
  // requiresApproval: true,  // force per-spawn approval at parent gate
  // forbidNesting: true,     // refuse to spawn grand-children
});
```

What the helpers do for you, end-to-end:

| Contract item      | Implementation                                                                |
| ------------------ | ----------------------------------------------------------------------------- |
| Parent linkage     | `metadata.parentRunId` + `metadata.spanId` on the child run record            |
| Policy inheritance | `createAgentProfilePolicy(childAgentProfile)` (compose with overrides)        |
| Approval channel   | `interactionChannel` passed through; pass `null` to suppress                  |
| Usage rollup       | `attachUsageRollup` subscribes to child tool/model events                     |
| Trace nesting      | Child events stay in child's `EventLog`; parent sees a summarized tool result |
| Cancellation       | `createRun({ abortSignal: parent.abortSignal })`                              |
| Recursion guard    | `createAgentTool({ forbidNesting: true })`                                    |

Distilled to the minimum portable shape, with all provider-specific message
plumbing left out (callers compose their own model + tools).

Core will only absorb a built-in `AgentTool` once these patterns are stable
across multiple consumers (in-process delegation, hosted multi-agent
orchestrators, planner+executor splits). Until then, `agent-runtime` is
where this contract lives.

## Concurrency Control (multi sub-agent fan-out)

When a Leader (primary run) fans out to multiple sub-agents in parallel, four
problems must be solved at the boundary: who can write where, how repo state
stays isolated, how progress is tracked, and how results flow back without
LLM re-parsing. `@sparkwright/agent-runtime` ships standalone primitives for
each — they compose with `spawnSubAgent` / `TaskManager` without changing
those APIs.

### Layered strategy

```
0. Partition by default               (each sub-agent gets its own files)
1a. Repo-internal code → Worktree     (parallel edits, ff-only merge)
1b. Repo-external files → file lock   (NOT yet shipped; declarative only)
1c. Todo / metadata → Leader single-writer (capability-gated tool)
```

Async dispatch and completion notification reuse `TaskManager` +
`TaskNotificationSink` from the [Sub-agents](#sub-agents) layer — no new
notification channel.

### ConcurrencyCoordinator (declarative partitioning)

```ts
import { ConcurrencyCoordinator } from "@sparkwright/agent-runtime";

const coord = new ConcurrencyCoordinator();
const r = coord.acquire("task-1", ["src/auth/**"]);
if (r.status === "conflict") {
  // r.conflictsWith lists in-flight claim ids whose globs overlap.
  // Leader chooses to queue, fail, or wait.
} else {
  // dispatch sub-agent; on terminal:
  coord.release("task-1");
}
```

Glob-overlap detection (`globsOverlap`) handles literal segments, `*` within a
segment, and `**` across segments. When both patterns have wildcards in
different positions, the algorithm is conservative — it may serialize
unnecessarily but never silently allows a real conflict.

### Worktree adapter

```ts
import { acquireWorktree } from "@sparkwright/agent-runtime";

const wt = await acquireWorktree({
  repoRoot,
  sessionDir, // .sparkwright/sessions/<sid>
  taskId: "task-1",
});
// dispatch sub-agent with workspace = wt.path
const merge = await wt.mergeBack(); // 3-way; pass { ffOnly: true } for chains
if (merge.status === "conflict") {
  await wt.release({ keep: true }); // leave for human inspection
} else {
  await wt.release();
}
```

Declarative partitioning makes the default 3-way merge conflict-free for
sibling branches (ff-only is only correct for chained workflows); conflict
outcomes are preserved for the rare cases where declarations drift. Paths follow
`<sessionDir>/worktrees/<taskId>`, branches follow `sw/<taskId>`.

### Todo (Leader single-writer)

```ts
import {
  createTodoTools,
  createAgentProfilePolicy,
} from "@sparkwright/agent-runtime";

const { todoRead, todoWrite } = createTodoTools({
  getTodoPath: () => `${sessionDir}/todo.md`,
});

// Child agents are denied todo_write via CapabilityRule:
const childPolicy = createAgentProfilePolicy({
  id: "worker",
  allowedTools: ["todo_read"],
  policy: [
    {
      action: "tool.execute",
      resource: "todo_write",
      effect: "deny",
      reason: "Only the Leader (primary agent) may update the todo file.",
    },
  ],
});
```

The on-disk format is GFM-compatible Markdown with a 5-state alphabet:
`[ ]` pending, `[ ] 🔄` in-progress, `[x]` completed, `[ ] ❌` failed,
`[~]` skipped. `todo_write` rewrites the file whole; the Leader keeps the
ordering / depth / notes the model produces.

### Sub-agent result protocol

```ts
import {
  SUB_AGENT_RESULT_PROMPT,
  parseSubAgentResult,
  validateDeclaredWrites,
} from "@sparkwright/agent-runtime";

// Splice SUB_AGENT_RESULT_PROMPT into the child's system prompt so the model
// learns to emit a JSON object as its final message.

const outcome = parseSubAgentResult(childResult.message ?? "");
if (outcome.kind === "ok") {
  const { violations } = validateDeclaredWrites(
    declaredWrites,
    outcome.value.writes,
  );
  if (violations.length > 0) {
    // Sub-agent wrote outside its declared partition → treat as failed.
  }
  // Update todo: ok→[x], partial→keep in_progress, fail+retryable→retry,
  //              fail+!retryable→[ ] ❌.
}
```

Parsing accepts a bare JSON object, a fenced ` ```json ` block, or an object
embedded at the end of free-form prose. Invalid output returns a structured
`{ kind: "invalid", reason }` so the Leader can record `[ ] ❌` and decide
whether to retry — no LLM round-trip to re-parse natural language.

## Versioning Guidance

Extension-facing interfaces should be conservative.

Before adding a new core option or event type, prefer:

- a helper that produces existing core inputs
- a `PromptSection` that renders one named prompt layer
- metadata on existing primitives
- a custom assembler, prompt builder, policy, or tool adapter
- documentation and tests that prove the pattern

Promote an extension pattern into core only after multiple adapters need the same shape.

## Design Checklist

Before adding an extension, answer:

1. Does this capability become context, a tool, policy input, approval flow, or artifact?
2. Can the core run loop stay unaware of its origin?
3. Can policy and approval block risky behavior?
4. Can trace explain which extension influenced the run?
5. Can large or sensitive data avoid prompt bloat?
6. If it changes model input, can it be a `PromptSection` or `ContextItem`
   instead of run-loop code?
7. Can the behavior be tested without a real provider?

If the answer is no, the adapter boundary needs more work before the feature belongs near core.
