# Extension Interfaces

This is a reference contract. If you are new to SparkWright, start with
[the documentation map](../README.md) or the [Capability Design Guide](../guides/CAPABILITY_DESIGN_GUIDE.md).

This document explains how applications and extension authors should connect optional capabilities to SparkWright core.

SparkWright core is intentionally small. Extensions should make agents more capable without bypassing the runtime boundary that makes runs inspectable, controllable, and recoverable.

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
priority-based: SparkWright-owned files are searched upward to the git root,
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
      path: ".sparkwright/skills/dingtalk-notifier/SKILL.md",
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
- If a tool cannot support a common input shape (for example, `read` with a
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
  skillRoots: [".sparkwright/skills"],
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

Skill scripts should be exposed as governed tools before execution. Inline
shell snippets inside `SKILL.md` are a narrower preprocessing feature: they
remain disabled by default, and hosts that enable them must inject an
`inlineShellRunner` through the skills `preprocess` option so execution can stay
inside host sandboxing and `extension.process.*` tracing.

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
  -> execute through SparkWright tool path
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
  mode?: "primary" | "child" | "all"; // carried for orchestration; not applied by agent-runtime
  model?: unknown; // not applied by agent-runtime; the host applies it to in-process delegate child runs
  prompt?: string; // compiled into the run prompt builder when spawning from this profile
  use?: string[]; // broad tool selectors intersected through parent/child profiles
  allowedTools?: string[];
  deniedTools?: string[];
  triggers?: string[]; // deterministic routing hints; hosts may sort/label but not grant permissions
  when?: {
    keywords?: string[]; // first lightweight routing condition supported by the host
  };
  delegateTool?: {
    toolName?: string;
    description?: string;
    requiresApproval?: boolean;
    forbidNesting?: boolean;
    maxSteps?: number;
  };
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

The in-process child helper now passes opaque accounts returned by
`RunHandle.getChildRunBudgetAccounts()` into child `CreateRunOptions`. Embedders
should propagate this protocol through `spawnSubAgent()` instead of inspecting
or recreating counters. It makes siblings and deeper descendants share each
ancestor's descendant-tree work ceiling while preserving each run's local
budget; it does not account for work hidden inside external processes.

Agent profiles that affect prompt behavior should become `ContextItem` values
or named prompt sections. Agent runtimes should compose runs or use child-run
helpers; they should not fork the core run loop to create a private prompt
path.

## Run Hooks

`RunHook` is the low-level lifecycle-middleware seam for embedders that need
in-process observability around the run loop. Prefer `WorkflowHook` or
`capabilities.hooks.workflow` for project-facing rules such as "do not edit
generated files", "run tests after writes", or "do not stop until verification
has happened". Keep `RunHook` for SDK, plugin, telemetry, and narrow
in-process integrations that need direct access to model/tool boundaries.

Supported callbacks:

- `beforeModelCall(input)` — before each model invocation (with current
  prompt and assembled context). Observational.
- `afterModelCall(input)` — after the model produced output and usage was
  recorded.
- `beforeToolCall(input)` — before a tool is executed. May return
  `{ skip: { reason } }` to short-circuit the call into a `failed`
  `ToolResult` (the only supported in-loop mutation). New tool policy should
  prefer workflow hook `PreToolUse`, which has matcher support, explicit
  block/rewrite semantics, and `workflow_hook.*` trace events.
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

## Workflow Hooks

`WorkflowHook` is the higher-level deterministic hook layer for rules that
must run at named agent lifecycle points. Prefer workflow hooks over `RunHook`
when the rule is user- or project-facing: "do not edit generated files",
"run this check after writes", "do not stop until the final answer mentions
tests", or "stop repeated tool calls before a doom loop".

Use this decision rule:

- Project configuration and checked-in workflow policy:
  `capabilities.hooks.workflow`.
- Code-level deterministic workflow policy:
  `createRun({ workflowHooks })`.
- In-process telemetry or loop instrumentation:
  `RunHook`.
- External event subscribers owned by a host:
  `UserHookRunner`.

Supported lifecycle names:

- `RunStart`
- `TurnStart`
- `ModelOutput`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `RunEnd`
- `RuntimeSignal`

`RunStart` and `RunEnd` are run-level start and end points; they are not
long-lived session boundaries. The hook names above are canonical in SDK,
configuration, inspection, and trace payloads.

Lifecycle effects:

| Lifecycle       | `block` effect                                                                                                                      | `advance` effect                                                                                      | `rewrite` effect                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `RunStart`      | Fails the run with `hook_stopped` / `WORKFLOW_HOOK_BLOCKED`.                                                                        | Unsupported.                                                                                          | No current effect.                                                                          |
| `TurnStart`     | Fails the run with `hook_stopped` / `WORKFLOW_HOOK_BLOCKED`.                                                                        | Unsupported.                                                                                          | No current effect.                                                                          |
| `ModelOutput`   | Adds blocked-continuation context and advances to another model turn.                                                               | Adds advance-continuation context and advances to another model turn without emitting a blocked hook. | No current effect.                                                                          |
| `PreToolUse`    | Synthesizes a failed `ToolResult` (`TOOL_BLOCKED_BY_WORKFLOW_HOOK`) and lets the run continue.                                      | Unsupported.                                                                                          | Rewrites requested tool arguments before budget, repeat, policy, and tool execution checks. |
| `PostToolUse`   | Adds continuation context after the completed or failed tool result; it does not undo the tool result.                              | Unsupported.                                                                                          | No current effect.                                                                          |
| `Stop`          | Adds blocked-continuation context and advances to another model turn instead of completing.                                         | Adds advance-continuation context and advances to another model turn instead of completing.           | No current effect.                                                                          |
| `RunEnd`        | Current call sites are fire-and-forget; a block can emit hook lifecycle events but does not change the already-terminal run result. | Unsupported.                                                                                          | No current effect.                                                                          |
| `RuntimeSignal` | Can fail or stop the run when called from an awaited runtime-signal gate.                                                           | Unsupported.                                                                                          | No current effect.                                                                          |

For tool calls, `PreToolUse` is a two-stage awaited gate. Rewrite-capable hooks
run first, core applies argument rewrites, and governance/block hooks then see
the rewritten arguments before budget, repeat, policy, approval, and tool
execution checks. The tool name is not rewritten. Unmarked in-process
`WorkflowHook` objects participate in the rewrite pass for compatibility;
hosts can mark their generated hooks for the governance pass.

Hooks are wired with `createRun({ workflowHooks: [...] })`. Each hook can
carry a matcher so broad lifecycle names remain usable without adding many
micro-hooks:

```ts
const blockGenerated: WorkflowHook = {
  name: "block-generated",
  description: "Prevent direct edits to generated files.",
  hook: "PreToolUse",
  matcher: {
    toolName: "write",
    pathGlob: "src/generated/**",
    excludePathGlob: "src/generated/fixtures/**",
  },
  handle() {
    return {
      status: "block",
      reason: "Generated files must not be edited directly.",
    };
  },
};
```

Matchers can narrow by `toolName`, `eventType`, `signal`, `status`, and
`pathGlob`. They can also use `excludePathGlob` to carve paths out of a broader
match. Matcher values accept either one string or an array of strings; glob
matching supports `*` for one path segment and `**` for multiple segments.

Handlers return one of:

- `continue` — optionally injects `ContextItem[]`.
- `block` — prevents the current lifecycle path from continuing; the concrete
  effect depends on the lifecycle table above.
- `advance` — a successful, non-violation continuation for `ModelOutput` and
  `Stop`; it emits `workflow_hook.completed`, not `workflow_hook.blocked`.
- `rewrite` — currently supported for `PreToolUse` tool arguments.
- `skipped` — records that a hook intentionally did nothing.

Every invocation emits `workflow_hook.started` and then exactly one terminal
event: `workflow_hook.completed`, `workflow_hook.blocked`, or
`workflow_hook.failed`. By default hook exceptions are logged and the run
continues, matching `RunHook`; set `onError: "block"` for governance hooks
that should fail closed.

Host config can set `capabilities.hooks.events` for non-blocking event
observation rules. Event rules compile through the user-hook event subscription
lane, not the awaited workflow-hook gates, so slow or failing event actions
cannot block the run or inject workflow context. They still emit `user_hook.*`
and, for command actions, `extension.process.*` evidence.

Configured command actions additionally run through the host
`TracedProcessRunner`. The hook lifecycle remains `workflow_hook.*`, while the
external process itself emits `extension.process.started` and a terminal
`extension.process.completed` / `extension.process.failed` with bounded output
summary and optional log artifacts. Progress reported through stderr
`SPARKWRIGHT_EVENT:` token lines is host-ingested: scripts do not write
arbitrary SparkWright events, and token lines are stripped from stderr previews,
artifacts, live output callbacks, and task output.

Command actions can set `resultMode: "stdoutJson"` to parse successful stdout
as a `WorkflowHookResult`. This lets a sandboxed command produce `block`,
`advance`, `rewrite`, `skipped`, or `continue` dynamically while preserving the
same core result protocol. Omit it, or use `exitCode`, to keep the legacy
exit-code behavior. When `stdoutJson` is enabled, stdout is reserved for the
final control JSON; progress belongs on stderr through the helper/wire protocol.
For configured `PreToolUse`, result-producing command/HTTP/agent actions run in
the rewrite pass, while static block/context actions run in the governance pass
and therefore match the rewritten arguments.

Workflow hook actions can also call `http(s)` endpoints (`type: "http"`) or
configured delegate agents (`type: "agent"`). HTTP actions can parse
`resultMode: "responseJson"` as a `WorkflowHookResult`, but host config keeps
HTTP hook transport fail-closed: project config cannot define HTTP hook actions
or `capabilities.hooks.http`, and trusted config must explicitly enable HTTP
hooks plus allow each destination. The default HTTP request body is a hook/run
summary, not the full run record or event payload. Private-network targets
require explicit opt-in, while link-local and cloud metadata addresses are
blocked. Agent actions can parse `resultMode: "workflowResult"`. Event hooks
support `command`, `http`, and `agent` actions in the non-blocking user-hook
lane.

The same runner also has an observation path for shell commands that were
already started in the foreground and then promoted to a task. In that case the
runner does not emit `extension.process.*`; it attaches stdout/stderr and the
terminal `ProcessOutputSummary` to `task.output` plus the terminal `task.*`
event under the task span.

## Interaction Channel

`InteractionChannel` is the unified _outbound_ channel from the runtime to a
user (CLI prompt, desktop modal, Slack/Feishu DM, etc.). It covers approvals,
free-form questions, and notifications through one runtime boundary.

```ts
interface InteractionChannel {
  approve?(request): Promise<ApprovalResponse>; // yes/no
  ask?(
    request: InteractionQuestionRequest,
  ): Promise<InteractionQuestionResponse>;
  notify?(notification: InteractionNotification): void | Promise<void>;
}
```

Wire via `createRun({ interactionChannel })`. `channel.approve` resolves risky
actions, while `RunHandle.askUser` / `RunHandle.notifyUser` route through the
same channel. Approval-only embedders provide an object containing only
`approve`; there is no parallel resolver option or precedence rule.

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

### File-authored commands and the `start_run` intent

`.sparkwright/command/*.md` files become commands without code via
[`@sparkwright/project-commands`](../../packages/project-commands). A command that
should begin a run does **not** start one itself; it yields a
front-end-agnostic intent that the embedder dispatches:

```ts
interface StartRunIntent {
  kind: "start_run";
  prompt: string; // body with $ARGUMENTS / $1 and !`shell` already interpolated
  model?: string; // optional per-command model override
  subtask: boolean; // spawn a child run rather than the main run
}
```

Embedder responsibilities:

- Pass the rest-of-line to the command so `$ARGUMENTS` / `$1..$9` resolve. (The
  TUI threads it through `onCommand(cmd, rest)` → `Command.runRaw`.)
- Supply a **safety-gated** shell runner for `` !`shell` `` segments via
  `createSafetyGatedShellRunner` — file-command shell rides the same
  `evaluateShellSafety` floor as model-invoked shell; `deny`/unknown commands are
  blocked, never executed.
- Decide how `prompt` / `model` / `subtask` map onto its run-start path. Explicit
  config-file declarations shadow same-named files (config wins).

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
   `InteractionChannel` unless the parent provides a sub-agent-specific
   channel. An approval-only child channel may expose only `approve` so the
   child cannot ask arbitrary user questions. Approvals from a child are
   visible in the parent's trace via the `parentRunId` linkage.
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

Before lifecycle execution, all built-in transports construct a serializable
`PreparedAgentInvocation`. Its `admissionState:"admission_pending"` is a
pre-start data state for governance/supervisor migration; it is not yet a new
raw event. The structure intentionally excludes live models, tools, policies,
emitters, run handles, and process handles.
`AgentSupervisor` consumes that data and owns requested/admitted/started plus
exactly-one-terminal projection. Adapters must complete governance admission
before reporting started; an admission failure is requested -> failed.

```ts
import {
  prepareAgentInvocation,
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
  policy: { risk: "safe", requiresApproval: false },
  buildSpawnInput: (input) => ({
    goal: input.goal,
    model: childModel,
    tools: childTools,
  }),
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

External command delegates keep this same parent-facing shape: the parent sees
`subagent.requested`, `subagent.started`, and a terminal `subagent.completed` /
`subagent.failed`. The host process execution path reuses `TracedProcessRunner`
for sandbox fallback, timeout, bounded stdout/stderr, and log artifacts, but it
does not emit a second `extension.process.*` lifecycle by default; the terminal
subagent result carries the shared `ProcessOutputSummary`.

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

### Todo Ledger (Leader single-writer)

```ts
import {
  createTodoTools,
  createAgentProfilePolicy,
  readTodoLedger,
  renderTodoLedgerContext,
  runTodoSupervised,
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

The on-disk format is GFM-compatible Markdown backed by the structured
`TodoLedger` API. Its status alphabet is `[ ]` pending, `[ ] 🔄` in-progress,
`[x]` completed, `[ ] ⛔` blocked, `[ ] ❌` failed, and `[~]` skipped.
`todo_write` rewrites the file whole; the Leader keeps the ordering, depth,
notes, optional `priority`, `doneWhen`, `owner`, and `evidence` fields the
model produces.

`evidence` is the important guardrail: todo status changes are self-reporting,
not proof of progress. Supervisors should treat external trace/workspace
signals (`workspace.write.completed`, `tool.completed`, `artifact.created`) and
item evidence (`file_changed`, `command`, `test`, `artifact`, `trace_event`) as
the progress source of truth.

For long-running or background agentic work, wrap ordinary runs with
`runTodoSupervised` rather than putting todo behavior into core or
`spawnSubAgent`:

```ts
await runTodoSupervised({
  todoPath: `${sessionDir}/todo.md`,
  maxContinuations: 3,
  maxStalledContinuations: 1,
  async runOnce(input) {
    const ledger = await readTodoLedger(`${sessionDir}/todo.md`);
    const context = [
      renderTodoLedgerContext(ledger, { sessionId }),
      ...(input.continuation ? [input.continuation.context] : []),
    ];
    // Create a normal run/session turn here. If input.continuation is present,
    // pass its prompt as a synthetic continuation message, not as user text.
    return { result, events };
  },
});
```

The supervisor audits terminal runs after they end. If the ledger is unfinished
and continuation is safe, it emits a synthetic continuation request:
`source="todo_supervisor"`, `reason="unfinished_todo"`. Hooks/plugins may veto
that continuation, but should not directly recurse into the model loop.

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
