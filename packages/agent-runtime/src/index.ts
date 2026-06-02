// AI maintenance note: agent-runtime owns the SUB-AGENT BOUNDARY. There are
// three layers:
//   1. AgentProfile + policy derivation (deriveChildAgentProfile,
//      compileAgentProfileRunOptions, createAgentProfilePolicy).
//   2. spawnSubAgent — parent RunHandle -> child RunHandle, with parent
//      linkage, abort propagation, channel sharing, and optional usage
//      rollup.
//   3. createAgentTool / mountAgentTool — wrap a spawnSubAgent invocation
//      in a ToolDefinition so the parent's LLM can delegate to a sub-agent
//      through the normal tool path (policy + approval still apply).
//
// The runtime contract this file enforces is documented in
// docs/EXTENSION_INTERFACES.md "Sub-agents".

import type {
  ContextItem,
  CreateRunOptions,
  EventEmitter,
  ModelAdapter,
  Policy,
  PolicyDecision,
  PolicyDecisionKind,
  PolicyResource,
  PromptBuilder,
  PromptMessage,
  RunBudget,
  RunHandle,
  RunHook,
  RunResult,
  RuntimeContext,
  InteractionChannel,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UsageSnapshot,
  UsageTracker,
} from "@sparkwright/core";
import {
  createAppPromptSection,
  createDefaultPolicy,
  createSpanId,
  createRun as defaultCreateRun,
  DefaultPromptBuilder,
  defineTool,
} from "@sparkwright/core";

export type PermissionEffect = "allow" | "deny" | "requires_approval";
export type AgentMode = "primary" | "child" | "all";

export interface ExperimentalAgentProfileOptions {
  /** Experimental only. Stored on derived profiles; not applied to runs. */
  mode?: AgentMode;
  /** Experimental only. Stored on derived profiles; not applied to model selection. */
  model?: unknown;
  /**
   * Application/domain-specific system prompt for this agent. When present, it
   * is compiled into a `promptBuilder` via `promptBuilderForAgentProfile` and
   * applied to runs spawned from this profile (see `spawnSubAgent` and
   * `compileAgentProfileRunOptions`).
   */
  prompt?: string;
}

export interface CapabilityRule {
  action: string;
  resource?: string;
  effect: PermissionEffect;
  reason?: string;
  metadata?: Record<string, unknown>;
  source?: "parent_agent" | "parent_run" | "child_agent" | "runtime";
}

export interface AgentProfile {
  id: string;
  name?: string;
  description?: string;
  experimental?: ExperimentalAgentProfileOptions;
  /**
   * @deprecated Not applied by agent-runtime. Use `experimental.mode` when you
   * need to carry this value for application-level orchestration.
   */
  mode?: AgentMode;
  /**
   * @deprecated Not applied by agent-runtime. Use `experimental.model` when you
   * need to carry this value for application-level orchestration.
   */
  model?: unknown;
  /**
   * @deprecated Not applied by agent-runtime. Use `experimental.prompt` when you
   * need to carry this value for application-level orchestration.
   */
  prompt?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  policy?: CapabilityRule[];
  maxSteps?: number;
  runBudget?: RunBudget;
  metadata?: Record<string, unknown>;
}

export interface DerivedChildAgentProfile {
  effectiveProfile: AgentProfile;
  inheritedPolicy: CapabilityRule[];
  effectivePolicy: CapabilityRule[];
  parentAgentDenyCount: number;
  parentRunDenyCount: number;
  childDenyCount: number;
  effectiveToolCount?: number;
}

export interface DeriveChildAgentProfileOptions {
  parentAgent?: AgentProfile;
  parentRunPolicy?: CapabilityRule[];
  childAgent: AgentProfile;
  /**
   * Optional event emitter (typically `run.events`). When provided, emits
   * one `agent.profile.derived` event per call.
   */
  emitter?: EventEmitter;
}

export type AgentProfileRunOptions = Pick<
  CreateRunOptions,
  "maxSteps" | "metadata" | "policy" | "runBudget" | "promptBuilder"
>;

/**
 * Compile a profile's application system prompt
 * (`experimental.prompt`) into a `PromptBuilder`. Returns `undefined` when the
 * profile carries no prompt, so callers can fall back to the run's default
 * builder (the harness resident contracts still apply either way — the app
 * prompt is layered on top via `additionalSections`).
 */
export function promptBuilderForAgentProfile(
  profile: AgentProfile,
): PromptBuilder<PromptMessage[]> | undefined {
  const prompt = profile.experimental?.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return undefined;
  }
  return new DefaultPromptBuilder({
    additionalSections: [createAppPromptSection(prompt)],
  });
}

export interface CompileAgentProfileRunOptionsOptions {
  fallbackPolicy?: Policy;
  metadata?: Record<string, unknown>;
  parentAgentId?: string;
}

export function deriveChildAgentProfile(
  options: DeriveChildAgentProfileOptions,
): DerivedChildAgentProfile {
  const parentAgentPolicy = tagRules(
    options.parentAgent?.policy ?? [],
    "parent_agent",
  );
  const parentRunPolicy = tagRules(options.parentRunPolicy ?? [], "parent_run");
  const childPolicy = tagRules(options.childAgent.policy ?? [], "child_agent");
  const inheritedPolicy = [
    ...parentRunPolicy.filter(isConstrainingRule),
    ...parentAgentPolicy.filter(isConstrainingRule),
  ];
  const effectivePolicy = [...inheritedPolicy, ...childPolicy];
  const allowedTools = intersectOptionalLists(
    options.parentAgent?.allowedTools,
    options.childAgent.allowedTools,
  );
  const deniedTools = uniqueSorted([
    ...(options.parentAgent?.deniedTools ?? []),
    ...(options.childAgent.deniedTools ?? []),
  ]);

  const derived: DerivedChildAgentProfile = {
    effectiveProfile: {
      ...options.childAgent,
      allowedTools,
      deniedTools,
      policy: effectivePolicy,
      maxSteps: minOptional(
        options.parentAgent?.maxSteps,
        options.childAgent.maxSteps,
      ),
      runBudget: minRunBudget(
        options.parentAgent?.runBudget,
        options.childAgent.runBudget,
      ),
      metadata: {
        ...(options.childAgent.metadata ?? {}),
        parentAgentId: options.parentAgent?.id,
      },
    },
    inheritedPolicy,
    effectivePolicy,
    parentAgentDenyCount: parentAgentPolicy.filter(isDenyRule).length,
    parentRunDenyCount: parentRunPolicy.filter(isDenyRule).length,
    childDenyCount: childPolicy.filter(isDenyRule).length,
    effectiveToolCount: allowedTools?.length,
  };

  if (options.emitter) {
    options.emitter.emit(
      "agent.profile.derived",
      {
        parentAgentId: options.parentAgent?.id,
        childAgentId: options.childAgent.id,
        effectiveToolCount: derived.effectiveToolCount,
      },
      {
        experimental: true,
        schemaVersion: "edge-trace.v0.1",
        sourcePackage: "@sparkwright/agent-runtime",
        inheritedPolicyCount: inheritedPolicy.length,
        effectivePolicyCount: effectivePolicy.length,
        parentAgentDenyCount: derived.parentAgentDenyCount,
        parentRunDenyCount: derived.parentRunDenyCount,
        childDenyCount: derived.childDenyCount,
      },
    );
  }

  return derived;
}

export function compileAgentProfileRunOptions(
  profile: AgentProfile,
  options: CompileAgentProfileRunOptionsOptions = {},
): AgentProfileRunOptions {
  const parentAgentId =
    options.parentAgentId ?? stringMetadata(profile.metadata, "parentAgentId");

  return {
    maxSteps: profile.maxSteps,
    runBudget: profile.runBudget,
    policy: createAgentProfilePolicy(profile, options.fallbackPolicy),
    promptBuilder: promptBuilderForAgentProfile(profile),
    metadata: removeUndefinedMetadata({
      ...(profile.metadata ?? {}),
      ...(options.metadata ?? {}),
      parentAgentId,
      agentId: profile.id,
      agentProfileId: profile.id,
      agentName: profile.name,
    }),
  };
}

export function createAgentProfilePolicy(
  profile: AgentProfile,
  fallback?: Policy,
): Policy {
  const fallbackPolicy = fallback ?? createDefaultPolicy();

  return {
    async decide(input): Promise<PolicyDecision> {
      const action = input.action;
      const resource = resourceFromPolicyInput(input.resource, input.metadata);
      const toolDecision = decideToolAccess(profile, action, resource);
      if (toolDecision) return toolDecision;

      const ruleDecision = decideByRules(
        tagRules(profile.policy ?? [], "child_agent"),
        action,
        resource,
      );
      if (ruleDecision) return ruleDecision;

      return fallbackPolicy.decide(input);
    },
  };
}

export function decideByRules(
  rules: CapabilityRule[],
  action: string,
  resource?: string,
): PolicyDecision | undefined {
  const matched = rules.filter((rule) => ruleMatches(rule, action, resource));
  const deny = matched.find((rule) => rule.effect === "deny");
  if (deny) return decisionFromRule(deny, "deny", action, resource);

  const approval = matched.find((rule) => rule.effect === "requires_approval");
  if (approval) {
    return decisionFromRule(approval, "requires_approval", action, resource);
  }

  const allow = matched.find((rule) => rule.effect === "allow");
  if (allow) return decisionFromRule(allow, "allow", action, resource);

  return undefined;
}

function decideToolAccess(
  profile: AgentProfile,
  action: string,
  resource?: string,
): PolicyDecision | undefined {
  if (action !== "tool.execute" || !resource) return undefined;

  if (matchesAny(resource, profile.deniedTools ?? [])) {
    return {
      action,
      decision: "deny",
      reason: `Tool denied by agent profile: ${resource}`,
      metadata: { resource, agentId: profile.id },
    };
  }

  if (
    profile.allowedTools !== undefined &&
    !matchesAny(resource, profile.allowedTools)
  ) {
    return {
      action,
      decision: "deny",
      reason: `Tool is outside agent allowed tools: ${resource}`,
      metadata: { resource, agentId: profile.id },
    };
  }

  return undefined;
}

function decisionFromRule(
  rule: CapabilityRule,
  decision: PolicyDecisionKind,
  action: string,
  resource?: string,
): PolicyDecision {
  return {
    action,
    decision,
    reason: rule.reason ?? `Matched agent capability rule: ${rule.effect}.`,
    metadata: {
      ...(rule.metadata ?? {}),
      resource,
      ruleSource: rule.source,
      ruleAction: rule.action,
      ruleResource: rule.resource,
    },
  };
}

function ruleMatches(
  rule: CapabilityRule,
  action: string,
  resource?: string,
): boolean {
  if (rule.action !== "*" && rule.action !== action) return false;
  if (!rule.resource || rule.resource === "*") return true;
  return resource !== undefined && matchesPattern(resource, rule.resource);
}

function resourceFromPolicyInput(
  resource: PolicyResource | undefined,
  metadata: Record<string, unknown> = {},
): string | undefined {
  const typed = resourceToMatchString(resource);
  if (typed !== undefined) return typed;
  return resourceFromMetadata(metadata);
}

function resourceToMatchString(
  resource: PolicyResource | undefined,
): string | undefined {
  if (!resource) return undefined;
  if (resource.kind === "tool" && typeof resource.name === "string") {
    return resource.name;
  }
  if (resource.kind === "workspace" && typeof resource.path === "string") {
    return resource.path;
  }
  if (typeof resource.id === "string") return resource.id;
  if (typeof resource.name === "string") return resource.name;
  if (typeof resource.path === "string") return resource.path;
  if (typeof resource.uri === "string") return resource.uri;
  return undefined;
}

function resourceFromMetadata(
  metadata: Record<string, unknown> = {},
): string | undefined {
  const direct = metadata.resource;
  if (typeof direct === "string") return direct;
  const toolName = metadata.toolName;
  if (typeof toolName === "string") return toolName;
  const path = metadata.path;
  if (typeof path === "string") return path;
  return undefined;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function removeUndefinedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function tagRules(
  rules: CapabilityRule[],
  source: NonNullable<CapabilityRule["source"]>,
): CapabilityRule[] {
  return rules.map((rule) => ({
    ...rule,
    source: rule.source ?? source,
  }));
}

function isConstrainingRule(rule: CapabilityRule): boolean {
  return rule.effect === "deny" || rule.effect === "requires_approval";
}

function isDenyRule(rule: CapabilityRule): boolean {
  return rule.effect === "deny";
}

function intersectOptionalLists(
  parent: string[] | undefined,
  child: string[] | undefined,
): string[] | undefined {
  if (parent === undefined) return child ? uniqueSorted(child) : undefined;
  if (child === undefined) return uniqueSorted(parent);
  return uniqueSorted(child.filter((item) => matchesAny(item, parent)));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function minOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function minRunBudget(
  left: RunBudget | undefined,
  right: RunBudget | undefined,
): RunBudget | undefined {
  if (!left) return right;
  if (!right) return left;

  return {
    maxDurationMs: minOptional(left.maxDurationMs, right.maxDurationMs),
    maxModelCalls: minOptional(left.maxModelCalls, right.maxModelCalls),
    maxToolCalls: minOptional(left.maxToolCalls, right.maxToolCalls),
    maxTokens: minOptional(left.maxTokens, right.maxTokens),
    maxCostUsd: minOptional(left.maxCostUsd, right.maxCostUsd),
  };
}

// ============================================================================
// Sub-agent runtime
//
// Implements the contract documented in docs/EXTENSION_INTERFACES.md
// "Sub-agents". Distilled to the minimum portable shape:
//
//   - parent linkage (parentRunId, spanId in child metadata)
//   - abort propagation (child wired with parent.abortSignal)
//   - policy inheritance (createLayeredPolicy + child profile policy)
//   - channel sharing (child inherits parent InteractionChannel)
//   - usage rollup (subscribe to child tool/model events, fan into parent
//     UsageTracker)
//   - summarized parent-side tool result (child events stay in child's
//     EventLog; parent sees a synthesized summary, not the raw transcript)
//
// Recursion guard: a parent that itself was spawned as a sub-agent is
// detected via `metadata.parentRunId` so callers can refuse to spawn
// grand-children when they prefer flat fan-out.
// ============================================================================

export interface SpawnSubAgentInput {
  parent: RunHandle;
  goal: string;
  /** Primary model adapter for the child. */
  model?: ModelAdapter;
  /** Optional model fallback chain for the child. */
  models?: ModelAdapter[];
  /** Tools registered for the child. Defaults to []. */
  tools?: ToolDefinition[];
  /** Seed context items injected into the child run. */
  context?: ContextItem[];
  maxSteps?: number;
  runBudget?: RunBudget;
  hooks?: RunHook[];
  /**
   * Optional child profile. When supplied, the child's effective policy is
   * derived via `deriveChildAgentProfile` + `createAgentProfilePolicy` and
   * layered on top of any explicit `policy` override.
   */
  childAgentProfile?: AgentProfile;
  /**
   * Optional parent profile used by `deriveChildAgentProfile` to derive the
   * effective child policy outside this helper.
   * @reserved Public sub-agent-protocol field consumed by orchestrators.
   */
  parentAgentProfile?: AgentProfile;
  /**
   * Explicit child policy override. When omitted, the helper builds one
   * from `childAgentProfile` (if any) or defers to `createDefaultPolicy()`.
   */
  policy?: Policy;
  /**
   * Prompt builder for the child run. When omitted, the helper derives one
   * from `childAgentProfile.experimental.prompt` (if set) so the child carries
   * its own application system prompt; otherwise the child uses core's default
   * builder. Pass an explicit builder to override.
   */
  promptBuilder?: PromptBuilder<PromptMessage[]>;
  /**
   * Interaction channel for the child. Default: inherit from `parent`'s
   * channel if the embedder passed one to `spawnSubAgent`. Pass `null` to
   * explicitly disable any user interaction from the child.
   */
  interactionChannel?: InteractionChannel | null;
  /**
   * Parent's UsageTracker. When supplied, the child's tool/model usage is
   * forwarded into this tracker so the parent's `usage()` snapshot reflects
   * the total cost of the run including children. Default: no rollup.
   */
  parentUsageTracker?: UsageTracker;
  metadata?: Record<string, unknown>;
  /**
   * Optional persistent store for the child run. Use this to place sub-agent
   * traces in the same session as the parent while keeping each agent's
   * transcript under its own directory.
   */
  runStore?: CreateRunOptions["runStore"];
  /** Override for testing. Defaults to the core `createRun`. */
  createRun?: typeof defaultCreateRun;
}

export interface SpawnedSubAgent {
  /** The child RunHandle. Call `.start()` to execute. */
  run: RunHandle;
  parentRunId: string;
  childRunId: string;
  /** Stable span id stamped on the child's metadata for trace stitching. */
  spanId: string;
  /**
   * Stop usage rollup (no-op if `parentUsageTracker` was not supplied).
   * Called automatically when the child run completes; callers can also
   * invoke it eagerly on cancellation.
   * @reserved Public sub-agent-protocol field consumed by orchestrators.
   */
  detachUsageRollup(): void;
}

/**
 * Spawn a child run under `parent`. Does NOT call `child.start()` — the
 * caller controls when the child executes (most embedders call `start()`
 * immediately and await the result, but background patterns may defer).
 *
 * Recursion: this function does not refuse nested calls. Callers that want
 * to forbid grand-children should check
 * `parent.record.metadata.parentRunId` themselves.
 */
export function spawnSubAgent(input: SpawnSubAgentInput): SpawnedSubAgent {
  const createRunFn = input.createRun ?? defaultCreateRun;
  const parent = input.parent;
  const spanId = createSpanId();
  const childAgentId =
    stringOrUndefined(input.metadata?.agentId) ?? input.childAgentProfile?.id;
  const childRunMetadata = removeUndefinedMetadata({
    ...(input.metadata ?? {}),
    parentRunId: parent.record.id,
    parentSpanId: parent.record.metadata?.spanId as string | undefined,
    spanId,
    agentId: childAgentId,
    agentProfileId: input.childAgentProfile?.id,
    agentName: input.childAgentProfile?.name,
  });

  // Build effective child policy: explicit override > profile-derived > default.
  const childPolicy =
    input.policy ??
    (input.childAgentProfile
      ? createAgentProfilePolicy(input.childAgentProfile)
      : undefined);

  // Build effective child prompt builder: explicit override > profile-derived
  // (experimental.prompt) > core default (undefined).
  const childPromptBuilder =
    input.promptBuilder ??
    (input.childAgentProfile
      ? promptBuilderForAgentProfile(input.childAgentProfile)
      : undefined);

  const createOptions: CreateRunOptions = {
    goal: input.goal,
    model: input.model,
    models: input.models,
    tools: input.tools ?? [],
    context: input.context,
    policy: childPolicy,
    promptBuilder: childPromptBuilder,
    interactionChannel:
      input.interactionChannel === null ? undefined : input.interactionChannel,
    hooks: input.hooks,
    maxSteps: input.maxSteps,
    runBudget: input.runBudget,
    abortSignal: parent.abortSignal,
    metadata: childRunMetadata,
    runStore: input.runStore,
  };

  const child = createRunFn(createOptions);

  let detach: () => void = () => {};
  if (input.parentUsageTracker) {
    detach = attachUsageRollup(input.parentUsageTracker, child);
  }

  // Sub-agent tri-state events emitted on the PARENT so a single trace tree
  // captures fan-out. `subagent.requested` fires immediately (the child run
  // exists but `.start()` has not been called); `subagent.started` and the
  // terminal events bridge from the child's own EventLog. The requested →
  // started gap is observable when the embedder queues `.start()` behind a
  // concurrency limit.
  const subagentBase = {
    childRunId: child.record.id,
    parentRunId: parent.record.id,
    spanId,
    goal: input.goal,
  };
  // Carry the child's identity on EVERY phase. The terminal events bridge from
  // the child's own EventLog, which has no knowledge of the parent-supplied
  // profile, so without this each later emit would lose `agentName` and a UI
  // would fall back to the opaque `childRunId` — making one sub-agent read as a
  // different actor on `started`/`completed` than it did on `requested`.
  const subagentMeta = {
    agentProfileId: input.childAgentProfile?.id,
    agentName: input.childAgentProfile?.name,
  };
  parent.events.emit("subagent.requested", subagentBase, subagentMeta);

  const unsubscribeBridge = child.events.subscribe((event) => {
    if (event.type === "run.started") {
      parent.events.emit("subagent.started", subagentBase, subagentMeta);
    } else if (event.type === "run.completed") {
      parent.events.emit(
        "subagent.completed",
        {
          ...subagentBase,
          stopReason: (event.payload as { stopReason?: string } | undefined)
            ?.stopReason,
        },
        subagentMeta,
      );
      detach();
      unsubscribeBridge();
    } else if (event.type === "run.failed" || event.type === "run.cancelled") {
      parent.events.emit(
        "subagent.failed",
        {
          ...subagentBase,
          reason: event.type === "run.cancelled" ? "cancelled" : "failed",
          error: (event.payload as { error?: unknown } | undefined)?.error,
        },
        subagentMeta,
      );
      detach();
      unsubscribeBridge();
    }
  });

  return {
    run: child,
    parentRunId: parent.record.id,
    childRunId: child.record.id,
    spanId,
    detachUsageRollup: () => detach(),
  };
}

/**
 * Subscribe to a child run's tool/model events and forward them into the
 * supplied parent UsageTracker. Returns an unsubscribe function.
 *
 * We listen to per-event signals (`tool.requested` + `tool.completed`/`failed`,
 * `model.completed`) rather than the child's `usage.updated` snapshot, so
 * the parent tracker sees one record per child action (matching the parent's
 * own bookkeeping).
 */
export function attachUsageRollup(
  parentTracker: UsageTracker,
  child: RunHandle,
): () => void {
  const toolNameByCall = new Map<string, string>();
  const unsubscribe = child.events.subscribe((event) => {
    if (event.type === "tool.requested") {
      const call = event.payload as ToolCall;
      toolNameByCall.set(call.id, call.toolName);
    } else if (
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      const result = event.payload as ToolResult;
      const toolName =
        toolNameByCall.get(result.toolCallId) ?? "<unknown-child-tool>";
      parentTracker.recordToolUsage({
        toolName,
        status: result.status,
      });
      toolNameByCall.delete(result.toolCallId);
    } else if (event.type === "model.completed") {
      const output = event.payload as { usage?: UsageSnapshot["tokens"] } & {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          costUsd?: number;
        };
      };
      parentTracker.recordModelUsage({
        adapterId: stringOrUndefined(child.record.metadata?.spanId),
        usage: output.usage,
      });
    }
  });
  return unsubscribe;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ----------------------------------------------------------------------------
// AgentTool: a ToolDefinition that delegates to spawnSubAgent.
// ----------------------------------------------------------------------------

export interface AgentToolInvocationInput {
  /** The goal forwarded to the child run. */
  goal: string;
  /** Optional free-form metadata supplied by the LLM. */
  metadata?: Record<string, unknown>;
}

export interface AgentToolSummarizeInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  /** Child's final usage snapshot at termination. */
  usage: UsageSnapshot;
}

export interface AgentToolResult {
  childRunId: string;
  spanId: string;
  signal: RunResult["signal"];
  stopReason: RunResult["stopReason"];
  message?: string;
  tokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  /** @reserved Public delegate-tool output field consumed by parent agents and UIs. */
  alreadyCompleted?: boolean;
  note?: string;
}

interface AgentToolCompletedCacheEntry {
  goal: string;
  result: AgentToolResult;
}

export interface CreateAgentToolOptions {
  /** Tool name registered with the parent. Default: "delegate". */
  name?: string;
  /** Tool description surfaced to the parent's LLM. */
  description?: string;
  /**
   * Build the spawn input from LLM-supplied arguments. Required because the
   * child's model, tools, and policy are not known at definition time.
   */
  buildSpawnInput(
    input: AgentToolInvocationInput,
    parent: RunHandle,
  ): Omit<SpawnSubAgentInput, "parent">;
  /**
   * Summarize the child's terminal state back into the parent-visible tool
   * result. Default: a small structured object with id/result/usage.
   */
  summarize?(input: AgentToolSummarizeInput): unknown;
  /**
   * If true, refuse to spawn when the parent itself is a sub-agent (i.e.
   * already carries `metadata.parentRunId`). Default: false.
   */
  forbidNesting?: boolean;
  /**
   * If true, the tool's policy advertises `requiresApproval`, forcing the
   * parent's approval gate before each sub-agent spawn. Default: false
   * (spawning is gated by the regular `risk: "risky"` policy path only).
   */
  requiresApproval?: boolean;
}

const DEFAULT_AGENT_TOOL_NAME = "delegate";
const DEFAULT_AGENT_TOOL_DESCRIPTION =
  "Delegate a bounded sub-task to a child agent. The child runs with its own context, tools, and policy; the parent sees only the summarized result.";

/**
 * Build a ToolDefinition that spawns a child run when the parent's LLM calls
 * it. The returned tool can be passed to `createRun({ tools: [tool] })`
 * BEFORE the parent exists by supplying a lazy parent accessor — useful when
 * the tool is built ahead of the run.
 */
export function createAgentTool(
  getParent: () => RunHandle | undefined,
  options: CreateAgentToolOptions,
): ToolDefinition {
  const name = options.name ?? DEFAULT_AGENT_TOOL_NAME;
  const description = options.description ?? DEFAULT_AGENT_TOOL_DESCRIPTION;
  const summarize = options.summarize ?? defaultSummarize;
  const successfulResultsByParent = new Map<
    string,
    AgentToolCompletedCacheEntry[]
  >();

  return defineTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Sub-task to delegate." },
        metadata: {
          type: "object",
          description: "Optional structured metadata for the child run.",
        },
      },
      required: ["goal"],
    },
    // Default risk is "safe": sub-agent SPAWN itself is a routine
    // decomposition action — the child run enforces its own policy on
    // anything the sub-agent does. Set `requiresApproval: true` to force
    // approval-on-spawn for embedders that need it.
    policy: {
      risk: "safe",
      requiresApproval: options.requiresApproval === true,
    },
    async execute(args: unknown, _ctx: RuntimeContext): Promise<unknown> {
      const parent = getParent();
      if (!parent) {
        throw new Error(
          `AgentTool "${name}" was invoked but no parent RunHandle is available.`,
        );
      }
      if (
        options.forbidNesting &&
        typeof parent.record.metadata?.parentRunId === "string"
      ) {
        throw new Error(
          `AgentTool "${name}" refused to nest: parent run is itself a sub-agent.`,
        );
      }
      const parsed = parseAgentToolArgs(args);
      const prior = findSimilarSuccessfulDelegation(
        successfulResultsByParent.get(parent.record.id) ?? [],
        parsed.goal,
      );
      if (prior) {
        return {
          ...prior.result,
          alreadyCompleted: true,
          note: "A similar delegation already completed in this parent run; summarize the previous child result instead of spawning another child agent.",
        };
      }
      const spawnOverrides = options.buildSpawnInput(parsed, parent);
      const spawned = spawnSubAgent({ ...spawnOverrides, parent });
      const result = await spawned.run.start();
      const usage = spawned.run.usage();
      const output = summarize({
        childRunId: spawned.childRunId,
        spanId: spawned.spanId,
        result,
        usage,
      });
      if (result.signal !== "completed") {
        throw new AgentToolRunError(name, output, result);
      }
      const structured = isAgentToolResult(output)
        ? output
        : defaultSummarize({
            childRunId: spawned.childRunId,
            spanId: spawned.spanId,
            result,
            usage,
          });
      const results = successfulResultsByParent.get(parent.record.id) ?? [];
      results.push({ goal: parsed.goal, result: structured });
      successfulResultsByParent.set(parent.record.id, results.slice(-8));
      return output;
    },
  });
}

/**
 * Convenience: build the agent tool and register it on `parent.tools`. Use
 * this when the parent run already exists. Returns the registered tool so
 * the caller can also pass it to other registries.
 */
export function mountAgentTool(
  parent: RunHandle,
  options: CreateAgentToolOptions,
): ToolDefinition {
  const tool = createAgentTool(() => parent, options);
  parent.tools.register(tool);
  return tool;
}

function parseAgentToolArgs(args: unknown): AgentToolInvocationInput {
  if (typeof args !== "object" || args === null) {
    throw new Error("AgentTool arguments must be an object.");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.goal !== "string" || record.goal.length === 0) {
    throw new Error("AgentTool arguments.goal must be a non-empty string.");
  }
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  return { goal: record.goal, metadata };
}

export * from "./tasks/index.js";
export * from "./concurrency/index.js";
export * from "./todo/index.js";

function defaultSummarize(input: AgentToolSummarizeInput): AgentToolResult {
  return {
    childRunId: input.childRunId,
    spanId: input.spanId,
    signal: input.result.signal,
    stopReason: input.result.stopReason,
    message: input.result.message,
    tokens: input.usage.tokens.total,
    costUsd: input.usage.costUsd,
    toolCalls: input.usage.toolCalls,
    modelCalls: input.usage.modelCalls,
  };
}

class AgentToolRunError extends Error {
  readonly code = "SUBAGENT_RUN_FAILED";
  readonly metadata: Record<string, unknown>;

  constructor(toolName: string, output: unknown, result: RunResult) {
    super(
      `AgentTool "${toolName}" child run ${result.signal}: ${result.stopReason}.`,
    );
    this.name = "AgentToolRunError";
    this.metadata = {
      toolName,
      signal: result.signal,
      stopReason: result.stopReason,
      message: result.message,
      output,
    };
  }
}

function isAgentToolResult(value: unknown): value is AgentToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { childRunId?: unknown }).childRunId === "string" &&
    typeof (value as { spanId?: unknown }).spanId === "string" &&
    typeof (value as { signal?: unknown }).signal === "string"
  );
}

function findSimilarSuccessfulDelegation(
  results: AgentToolCompletedCacheEntry[],
  goal: string,
): { result: AgentToolResult } | undefined {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const candidate = results[i];
    if (!candidate) continue;
    if (similarGoalScore(candidate.goal, goal) >= 0.35) {
      return { result: candidate.result };
    }
  }
  return undefined;
}

function similarGoalScore(a: string, b: string): number {
  if (hasDirectoryListingIntent(a) && hasDirectoryListingIntent(b)) return 0.7;
  const left = normalizeGoalForSimilarity(a);
  const right = normalizeGoalForSimilarity(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  const leftBigrams = charBigrams(left);
  const rightBigrams = charBigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;
  let overlap = 0;
  for (const item of leftBigrams) {
    if (rightBigrams.has(item)) overlap += 1;
  }
  return (2 * overlap) / (leftBigrams.size + rightBigrams.size);
}

function hasDirectoryListingIntent(goal: string): boolean {
  const normalized = goal.toLowerCase();
  const asksToList = /列出|清单|有哪些|查看|list|show|inspect/.test(normalized);
  const mentionsFiles =
    /文件|目录|文件夹|条目|file|files|dir|directory|entries/.test(normalized);
  const scopesWorkspace =
    /当前|工作区|根目录|workspace|root|directory|cwd|\./.test(normalized);
  return asksToList && mentionsFiles && scopesWorkspace;
}

function normalizeGoalForSimilarity(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[`"'“”‘’（）()[\]{}，。；;：:、,.!?！？\s]+/g, "")
    .replace(/\/applications\/xgw\/projects\/ai-native\/sparkwright/g, "")
    .replace(/workspace|sparkwright|当前|目录|文件|文件夹|清单/g, "");
}

function charBigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  const out = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) {
    out.add(value.slice(i, i + 2));
  }
  return out;
}
