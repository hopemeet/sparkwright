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
  WorkflowHook,
  WorkflowHookMatcher,
  WorkflowHookName,
} from "@sparkwright/core";
import {
  createAppPromptSection,
  createDefaultPolicy,
  createSpanId,
  createRun as defaultCreateRun,
  DefaultPromptBuilder,
  defineTool,
} from "@sparkwright/core";
import type {
  AgentToolInvocationInput,
  AgentToolResult,
  AgentToolSummarizeInput,
  DelegationLedgerKey,
  DelegationLedgerResult,
} from "./agents/types.js";
import {
  findSimilarSuccessfulDelegation,
  rememberSuccessfulDelegation,
  withAlreadyCompletedNote,
} from "./agents/delegation-ledger.js";
import type {
  AgentAssetIdentity,
  PreparedAgentInvocation,
  SubAgentEntrypoint,
} from "./agents/invocation.js";
import { createAgentSupervisor } from "./agents/supervisor.js";
import {
  agentInvocationEntrypointFromArgs,
  isSubAgentEntrypoint,
  prepareAgentInvocation,
} from "./agents/invocation.js";

export type {
  AgentToolInvocationInput,
  AgentToolResult,
  AgentToolSummarizeInput,
  DelegationLedgerHit,
  DelegationLedgerKey,
  DelegationLedgerResult,
} from "./agents/types.js";
export {
  findSimilarSuccessfulDelegation,
  rememberSuccessfulDelegation,
  withAlreadyCompletedNote,
} from "./agents/delegation-ledger.js";
export type {
  AgentAssetIdentity,
  AgentInvocationProtocol,
  AgentInvocationWorkspaceAccess,
  PreparedAgentInvocation,
  PreparedAgentInvocationGovernance,
  PrepareAgentInvocationInput,
  SubAgentEntrypoint,
} from "./agents/invocation.js";
export type {
  AgentSupervisor,
  AgentSupervisorState,
} from "./agents/supervisor.js";
export { createAgentSupervisor } from "./agents/supervisor.js";
export {
  agentInvocationEventBase,
  agentInvocationEntrypointFromArgs,
  agentInvocationMetadata,
  isSubAgentEntrypoint,
  markAgentInvocationEntrypoint,
  PREPARED_AGENT_INVOCATION_SCHEMA_VERSION,
  prepareAgentInvocation,
} from "./agents/invocation.js";

export type PermissionEffect = "allow" | "deny" | "requires_approval";
export type AgentMode = "primary" | "child" | "all";

export interface CapabilityRule {
  action: string;
  resource?: string;
  effect: PermissionEffect;
  reason?: string;
  metadata?: Record<string, unknown>;
  source?: "parent_agent" | "parent_run" | "child_agent" | "runtime";
}

export interface AgentProfileDelegateTool {
  toolName?: string;
  description?: string;
  requiresApproval?: boolean;
  forbidNesting?: boolean;
  maxSteps?: number;
}

export interface AgentProfileRoutingCondition {
  /**
   * Optional deterministic keyword hints used by hosts to sort or annotate
   * delegate tools for a specific goal. They are hints only; they must not
   * grant permissions or hide a delegate unless an embedder opts into a
   * separate gating mode.
   */
  keywords?: string[];
}

export type AgentProfileWorkflowHookOutputInjection =
  | "always"
  | "onFailure"
  | "never";

export type AgentProfileWorkflowHookAction =
  | {
      type: "block";
      reason: string;
    }
  | {
      type: "context";
      content: string;
      contextType?: "system" | "user" | "summary";
    }
  | {
      type: "command";
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      blockOnFailure?: boolean;
      injectOutput?: AgentProfileWorkflowHookOutputInjection;
      maxOutputBytes?: number;
      stdin?: "none" | "json";
      resultMode?: "exitCode" | "stdoutJson";
    }
  | {
      type: "http";
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      blockOnFailure?: boolean;
      injectOutput?: AgentProfileWorkflowHookOutputInjection;
      resultMode?: "status" | "responseJson";
    };

export interface AgentProfileWorkflowHookConfig {
  name: string;
  description?: string;
  hook: WorkflowHookName;
  enabled?: boolean;
  onError?: "continue" | "block";
  frequency?: "always" | "oncePerTurn";
  matcher?: WorkflowHookMatcher;
  action: AgentProfileWorkflowHookAction;
}

export interface AgentProfile {
  id: string;
  name?: string;
  description?: string;
  /**
   * Profile role. Carried on derived profiles for application-level
   * orchestration; not applied to runs by agent-runtime itself.
   */
  mode?: AgentMode;
  /**
   * Preferred model ("provider/model") for this profile. agent-runtime carries
   * it for orchestration but does not select on it; the host applies it to
   * in-process delegate child runs (see `resolveProfileModelAdapters` and
   * `createConfiguredDelegateTools` in @sparkwright/host).
   */
  model?: unknown;
  /**
   * Application/domain-specific system prompt for this agent. When present, it
   * is compiled into a `promptBuilder` via `promptBuilderForAgentProfile` and
   * applied to runs spawned from this profile (see `spawnSubAgent` and
   * `compileAgentProfileRunOptions`).
   */
  prompt?: string;
  /**
   * Host-owned high-level tool selectors. Agent-runtime carries and narrows
   * them for profile inheritance; embedders expand them to concrete tools.
   */
  use?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  /**
   * Optional deterministic routing hints for delegate discovery. Hosts may use
   * these to sort/label delegate tools for a goal; absence preserves the
   * profile's existing ordering and visibility.
   */
  triggers?: string[];
  /**
   * Lightweight routing condition hints. The first host implementation only
   * supports keyword matching (`when.keywords`) and treats it the same as
   * `triggers`; richer condition DSLs should be added deliberately.
   */
  when?: AgentProfileRoutingCondition;
  delegateTool?: AgentProfileDelegateTool;
  /**
   * Tri-state opt-in/opt-out for automatic delegate exposure. `undefined` means
   * "not configured" (the host's `capabilities.agents.exposeChildrenAsDelegates`
   * flag decides for direct aliases); `true` forces this child/all profile into
   * automatic delegate exposure even when the global flag is off; `false`
   * suppresses automatic `delegate_agent` targeting and direct alias exposure.
   * An explicit `delegateTool` (inline) or a
   * `capabilities.agents.delegateTools[]` entry still wins. See
   * `resolveAgentDelegateTools` in @sparkwright/host.
   */
  exposeAsDelegate?: boolean;
  /**
   * Neutral deterministic workflow-hook carrier for profile-authored child-run
   * guardrails. Host compiles this structural shape into runtime
   * `WorkflowHook[]`; agent-runtime does not import host config types.
   */
  hooks?: AgentProfileWorkflowHookConfig[];
  policy?: CapabilityRule[];
  maxSteps?: number;
  runBudget?: RunBudget;
  metadata?: Record<string, unknown>;
  /**
   * @reserved Host-resolved Markdown package identity consumed by trace-derived
   * attribution and statistics; it must be captured at invocation time.
   */
  assetIdentity?: AgentAssetIdentity;
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
 * Compile a profile's application system prompt into a `PromptBuilder`.
 * Returns `undefined` when the profile carries no prompt, so callers can fall
 * back to the run's default builder (the harness resident contracts still apply
 * either way — the app prompt is layered on top via `additionalSections`).
 */
export function promptBuilderForAgentProfile(
  profile: AgentProfile,
): PromptBuilder<PromptMessage[]> | undefined {
  const prompt = profile.prompt;
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
  const use = intersectAgentProfileUse(
    options.parentAgent?.use,
    options.childAgent.use,
  );
  const deniedTools = uniqueSorted([
    ...(options.parentAgent?.deniedTools ?? []),
    ...(options.childAgent.deniedTools ?? []),
  ]);

  const derived: DerivedChildAgentProfile = {
    effectiveProfile: {
      ...options.childAgent,
      use,
      allowedTools,
      deniedTools,
      policy: effectivePolicy,
      maxSteps: options.childAgent.maxSteps ?? options.parentAgent?.maxSteps,
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

function stringArrayMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

function numberMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nextSubagentDepth(
  metadata: Record<string, unknown> | undefined,
): number {
  const current = numberMetadata(metadata, "subagentDepth");
  if (current !== undefined && current >= 0) return Math.floor(current) + 1;
  return typeof metadata?.parentRunId === "string" ? 2 : 1;
}

function removeUndefinedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function intersectAgentProfileUse(
  parent: string[] | undefined,
  child: string[] | undefined,
): string[] | undefined {
  if (parent === undefined) return child ? uniqueSorted(child) : undefined;
  if (child === undefined) return uniqueSorted(parent);
  const out: string[] = [];
  for (const parentSelector of parent) {
    for (const childSelector of child) {
      for (const selector of intersectOneUseSelector(
        parentSelector,
        childSelector,
      )) {
        out.push(selector);
      }
    }
  }
  return uniqueSorted(out);
}

function intersectOneUseSelector(left: string, right: string): string[] {
  if (left === right) return [left];
  if (left === "mcp" && isMcpServerUseSelector(right)) return [right];
  if (right === "mcp" && isMcpServerUseSelector(left)) return [left];
  return [];
}

function isMcpServerUseSelector(selector: string): boolean {
  return (
    selector.startsWith("mcp:") && selector.slice("mcp:".length).length > 0
  );
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
//   - abort propagation (child wired with input.abortSignal ?? parent.abortSignal;
//     a task-owned signal decouples a background child from the parent turn)
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
  /**
   * Workspace for the child's {@link RuntimeContext}. Defaults to the parent's
   * workspace (`parent.getWorkspace()`) so workspace-backed child tools like
   * `read` resolve against the same root the parent uses, instead of
   * throwing "Workspace is not configured". Pass an explicit value to override,
   * or `null` to deliberately run the child without a workspace.
   */
  workspace?: CreateRunOptions["workspace"] | null;
  maxSteps?: number;
  runBudget?: RunBudget;
  hooks?: RunHook[];
  /**
   * Deterministic workflow hooks registered on the child run. Distinct from the
   * lower-level `hooks`/RunHook lane.
   */
  workflowHooks?: WorkflowHook[];
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
   * from the child profile `prompt` so the child carries its own application
   * system prompt; otherwise the child uses core's default builder. Pass an
   * explicit builder to override.
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
  /**
   * External abort signal that owns the child's lifecycle. Defaults to
   * `parent.abortSignal`, which ties the child to the parent turn. Pass a
   * task-owned signal (e.g. a background-task controller) to decouple the
   * child from the parent turn so stopping the task stops the child and a
   * parent-turn interrupt does not kill a background child.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional embedder-owned admission gate. The child is created and
   * `subagent.requested` is emitted before this gate runs; the internal
   * supervisor enters its admitted state only after it resolves. The returned
   * release callback is held for the full child execution and invoked exactly
   * once afterwards.
   *
   * Callers that provide a gate must start the child through the returned
   * {@link SpawnedSubAgent.start} method so the gate cannot be bypassed.
   */
  admission?(input: {
    invocation: PreparedAgentInvocation;
    abortSignal: AbortSignal;
    /** Abort the created child if admitted ownership is later lost. */
    cancel(reason: string, metadata?: Record<string, unknown>): void;
  }): Promise<(() => void) | void>;
  /** Override for testing. Defaults to the core `createRun`. */
  createRun?: typeof defaultCreateRun;
}

export interface SpawnedSubAgent {
  /** The child RunHandle. Prefer {@link start} to honor optional admission. */
  run: RunHandle;
  /** Admit and execute the child once, returning the shared start promise. */
  start(): Promise<RunResult>;
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

export type SubAgentTerminalState =
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "step_limit"
  | "truncated";

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
  const parentAgentId =
    stringOrUndefined(parent.record.metadata?.agentId) ?? "main";
  const sessionId =
    stringOrUndefined(parent.record.metadata?.sessionId) ??
    stringOrUndefined(input.metadata?.sessionId);
  const subagentDepth =
    numberMetadata(input.metadata, "subagentDepth") ??
    nextSubagentDepth(parent.record.metadata);
  const childRunMetadata = removeUndefinedMetadata({
    ...(input.metadata ?? {}),
    ancestorRunIds: [
      ...stringArrayMetadata(parent.record.metadata, "ancestorRunIds"),
      parent.record.id,
    ],
    parentRunId: parent.record.id,
    parentSpanId: parent.record.metadata?.spanId as string | undefined,
    sessionId,
    spanId,
    subagentDepth,
    agentId: childAgentId,
    agentProfileId: input.childAgentProfile?.id,
    agentName: input.childAgentProfile?.name,
    ...(input.childAgentProfile?.assetIdentity
      ? { agentAssetIdentity: input.childAgentProfile.assetIdentity }
      : {}),
  });

  // Build effective child policy: explicit override > profile-derived > default.
  const childPolicy =
    input.policy ??
    (input.childAgentProfile
      ? createAgentProfilePolicy(input.childAgentProfile)
      : undefined);

  // Build effective child prompt builder: explicit override > profile-derived
  // prompt > core default (undefined).
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
    // Inherit the parent's workspace unless the caller overrides it (or opts
    // out with `null`), so workspace-backed child tools resolve against the
    // same root instead of throwing "Workspace is not configured".
    workspace:
      input.workspace === null
        ? undefined
        : (input.workspace ?? parent.getWorkspace?.()),
    policy: childPolicy,
    promptBuilder: childPromptBuilder,
    interactionChannel:
      input.interactionChannel === null ? undefined : input.interactionChannel,
    hooks: input.hooks,
    workflowHooks: input.workflowHooks,
    maxSteps: input.maxSteps ?? parent.maxSteps,
    runBudget: input.runBudget,
    ancestorRunBudgetAccounts: parent.getChildRunBudgetAccounts(),
    abortSignal: input.abortSignal ?? parent.abortSignal,
    metadata: childRunMetadata,
    runStore: input.runStore,
  };

  const child = createRunFn(createOptions);
  const startChild = child.start.bind(child);

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
  const taskId = stringMetadata(input.metadata, "taskId");
  const invocation: PreparedAgentInvocation = prepareAgentInvocation({
    goal: input.goal,
    protocol: "in_process",
    sessionId,
    parentRunId: parent.record.id,
    childRunId: child.record.id,
    spanId,
    taskId,
    agentId: parentAgentId,
    childAgentId,
    agentProfileId: input.childAgentProfile?.id,
    agentName: input.childAgentProfile?.name,
    agentAssetIdentity: input.childAgentProfile?.assetIdentity,
    delegateTool: stringMetadata(input.metadata, "delegateTool"),
    subagentDepth,
    entrypoint: subagentEntrypointFromMetadata(input.metadata),
    governance: agentInvocationGovernanceFromMetadata(input.metadata),
  });
  const supervisor = createAgentSupervisor({
    invocation,
    emitter: parent.events,
  });
  supervisor.requested();
  if (!input.admission) supervisor.admit();

  // Roll up the child's own workspace writes onto the parent-visible terminal
  // event. The child run records each `edit`/`edit_anchored_text` as a
  // `workspace.write.completed` on its OWN trace; the parent run-end summary is
  // parent-scoped and never sees those. Counting the child's real write events
  // here (rather than re-detecting changes with a parent-side filesystem
  // snapshot) keeps a single source of truth, attributes writes to the actor
  // that made them, and avoids representing one change as two event families.
  let childWorkspaceWrites = 0;
  const unsubscribeBridge = child.events.subscribe((event) => {
    if (event.type === "workspace.write.completed") {
      childWorkspaceWrites += 1;
      return;
    }
    if (event.type === "run.started") {
      supervisor.started();
    } else if (event.type === "run.completed") {
      const terminal = subagentTerminalProjection("run.completed", event);
      supervisor.completed({
        stopReason: childStopReason(event.payload),
        ...terminal,
        ...(childWorkspaceWrites > 0
          ? { workspaceWrites: childWorkspaceWrites }
          : {}),
      });
      detach();
      unsubscribeBridge();
    } else if (event.type === "run.failed" || event.type === "run.cancelled") {
      const terminal = subagentTerminalProjection(event.type, event);
      supervisor.failed({
        reason: terminal.terminalState === "cancelled" ? "cancelled" : "failed",
        error: (event.payload as { error?: unknown } | undefined)?.error,
        ...terminal,
        ...(childWorkspaceWrites > 0
          ? { workspaceWrites: childWorkspaceWrites }
          : {}),
      });
      detach();
      unsubscribeBridge();
    }
  });

  let startPromise: Promise<RunResult> | undefined;
  const start = (): Promise<RunResult> => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      let releaseAdmission: (() => void) | undefined;
      try {
        if (input.admission) {
          const admitted = await input.admission({
            invocation,
            abortSignal: createOptions.abortSignal ?? parent.abortSignal,
            cancel: (reason, metadata) => {
              child.cancel({ reason, metadata });
            },
          });
          releaseAdmission = admitted || undefined;
          supervisor.admit();
        }
        return await startChild();
      } catch (error) {
        supervisor.failed({
          reason:
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        releaseAdmission?.();
      }
    })();
    return startPromise;
  };

  // Preserve the public RunHandle inspection surface without leaving a second
  // executable path that can bypass admission. `stream()` also observes this
  // instance method, so every start route shares the same one-shot promise.
  child.start = start;

  return {
    run: child,
    start,
    parentRunId: parent.record.id,
    childRunId: child.record.id,
    spanId,
    detachUsageRollup: () => detach(),
  };
}

function childStopReason(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const reason = payload.reason;
  if (typeof reason === "string") return reason;
  const stopReason = payload.stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function subagentEntrypointFromMetadata(
  metadata: Record<string, unknown> | undefined,
): SubAgentEntrypoint {
  const entrypoint = metadata?.entrypoint;
  return isSubAgentEntrypoint(entrypoint) ? entrypoint : "run";
}

function agentInvocationGovernanceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): PreparedAgentInvocation["governance"] {
  const workspaceAccess = metadata?.workspaceAccess;
  const concurrency = metadata?.agentConcurrency;
  if (
    workspaceAccess !== "none" &&
    workspaceAccess !== "read_only" &&
    workspaceAccess !== "read_write"
  ) {
    return undefined;
  }
  return {
    workspaceAccess,
    ...(concurrency === "serial" || concurrency === "concurrent"
      ? { concurrency }
      : {}),
  };
}

function subagentTerminalProjection(
  eventType: "run.completed" | "run.failed" | "run.cancelled",
  event: { payload?: unknown },
): {
  terminalState: SubAgentTerminalState;
  finality: "complete" | "partial";
  stepLimitReached?: boolean;
  truncated?: boolean;
} {
  const payload = isRecord(event.payload) ? event.payload : {};
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const stepLimitReached =
    payload.stepLimitReached === true || metadata?.stepLimitReached === true;
  const truncated = payload.truncated === true || metadata?.truncated === true;
  if (truncated) {
    return {
      terminalState: "truncated",
      finality: "partial",
      stepLimitReached,
      truncated: true,
    };
  }
  if (stepLimitReached) {
    return {
      terminalState: "step_limit",
      finality: "partial",
      stepLimitReached: true,
    };
  }
  if (eventType === "run.cancelled")
    return { terminalState: "cancelled", finality: "partial" };
  if (eventType === "run.failed") {
    if (runFailureWasAbort(payload)) {
      return { terminalState: "cancelled", finality: "partial" };
    }
    const stopReason =
      typeof payload.reason === "string"
        ? payload.reason
        : typeof payload.stopReason === "string"
          ? payload.stopReason
          : undefined;
    return {
      terminalState: stopReason === "blocking_limit" ? "blocked" : "failed",
      finality: "partial",
    };
  }
  return { terminalState: "completed", finality: "complete" };
}

function runFailureWasAbort(payload: Record<string, unknown>): boolean {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const failure = isRecord(payload.failure) ? payload.failure : undefined;
  const failureMetadata = isRecord(failure?.metadata)
    ? failure.metadata
    : undefined;
  const modelError = isRecord(metadata?.modelError)
    ? metadata.modelError
    : isRecord(failureMetadata?.modelError)
      ? failureMetadata.modelError
      : undefined;
  return (
    recordErrorName(metadata?.cause) === "AbortError" ||
    recordErrorName(failureMetadata?.cause) === "AbortError" ||
    abortishString(payload.code) ||
    abortishString(payload.message) ||
    abortishString(failure?.code) ||
    abortishString(failure?.message) ||
    abortishString(modelError?.code) ||
    abortishString(modelError?.message)
  );
}

function recordErrorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.name === "string" ? value.name : undefined;
}

function abortishString(value: unknown): boolean {
  return typeof value === "string" && /\babort(?:ed|error)?\b/i.test(value);
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
        trace?: { adapterId?: string };
      };
      // Bucket child spend by the model that actually incurred it so the
      // parent's `byModel` stays a real per-model breakdown (child and parent
      // calls on the same model collapse into one slot). Fall back to the
      // child's spanId only if the model.completed payload omits adapterId.
      parentTracker.recordModelUsage({
        adapterId:
          stringOrUndefined(output.trace?.adapterId) ??
          stringOrUndefined(child.record.metadata?.spanId),
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
  ):
    | Omit<SpawnSubAgentInput, "parent">
    | Promise<Omit<SpawnSubAgentInput, "parent">>;
  /**
   * Stable identity for sharing completed delegation results with other
   * delegation entrypoints on the same parent run.
   */
  delegationLedgerKey?: DelegationLedgerKey;
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
   * Effective capability-derived policy for the spawn action.
   */
  policy: ToolDefinition["policy"];
  /**
   * Optional host-derived admission classifier for the child capability set.
   * Return true only when concurrent child execution cannot mutate shared
   * resources and does not require a serialized spawn approval.
   */
  isConcurrencySafe?(input: AgentToolInvocationInput): boolean;
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
  const delegationLedgerKey = options.delegationLedgerKey ?? {
    kind: "agent_tool",
    delegateTool: name,
  };

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
    policy: options.policy,
    governance: {
      origin: { kind: "local", name: "@sparkwright/agent-runtime" },
      sideEffects: ["external"],
      idempotency: "conditional",
    },
    ...(options.isConcurrencySafe
      ? { isConcurrencySafe: options.isConcurrencySafe }
      : {}),
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
        parent,
        delegationLedgerKey,
        parsed.goal,
      );
      if (prior) {
        return withAlreadyCompletedNote(prior.result);
      }
      const spawnOverrides = await options.buildSpawnInput(parsed, parent);
      const invocationEntrypoint = agentInvocationEntrypointFromArgs(args);
      const spawned = spawnSubAgent({
        ...spawnOverrides,
        parent,
        ...(invocationEntrypoint
          ? {
              metadata: {
                ...(spawnOverrides.metadata ?? {}),
                entrypoint: invocationEntrypoint,
              },
            }
          : {}),
      });
      const result = await spawned.start();
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
      const stepLimitReached = runResultStepLimitReached(result);
      const structured = isAgentToolResult(output)
        ? output
        : defaultSummarize({
            childRunId: spawned.childRunId,
            spanId: spawned.spanId,
            result,
            usage,
          });
      if (stepLimitReached) {
        return withStepLimitReachedNote(output, structured);
      }
      rememberSuccessfulDelegation(parent, delegationLedgerKey, parsed.goal, {
        ...structured,
      });
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
export * from "./doc-store/index.js";
export * from "./concurrency/index.js";
export * from "./todo/index.js";
export * from "./workflows/index.js";

function defaultSummarize(input: AgentToolSummarizeInput): AgentToolResult {
  return summarizeDelegationResult(input);
}

export function summarizeDelegationResult(
  input: AgentToolSummarizeInput,
): DelegationLedgerResult {
  const stepLimitReached = runResultStepLimitReached(input.result);
  const truncated = runResultTruncated(input.result) || stepLimitReached;
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
    ...(stepLimitReached ? { stepLimitReached: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function runResultStepLimitReached(result: RunResult): boolean {
  return (
    (result.metadata as { stepLimitReached?: unknown } | undefined)
      ?.stepLimitReached === true
  );
}

function runResultTruncated(result: RunResult): boolean {
  return (
    (result.metadata as { truncated?: unknown } | undefined)?.truncated === true
  );
}

function withStepLimitReachedNote(
  output: unknown,
  structured: AgentToolResult,
): unknown {
  const note =
    "Child run answered on its last allowed step; treat the result as possibly truncated and not definitively complete.";
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    return {
      ...output,
      stepLimitReached: true,
      note:
        typeof (output as { note?: unknown }).note === "string"
          ? `${(output as { note: string }).note} ${note}`
          : note,
    };
  }
  return { ...structured, stepLimitReached: true, note };
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
