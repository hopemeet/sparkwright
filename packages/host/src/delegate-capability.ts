import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunHandle, ToolDefinition } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import { matchSkills } from "@sparkwright/skills";
import { MAIN_AGENT_ID } from "./agent-constants.js";
import type { CapabilityDelegateToolConfig } from "./config-zod-schema.js";

export type DelegateProtocol = "acp" | "external_command" | "in_process";
export type DelegateWorkspaceAccess = "none" | "read_write";
export type DelegateInvocationRisk = NonNullable<
  NonNullable<ToolDefinition["policy"]>["risk"]
>;
export type DelegateFailureCode =
  | "DELEGATE_APPROVAL_DENIED"
  | "DELEGATE_WORKSPACE_ACCESS_DENIED"
  | "DELEGATE_TIMEOUT"
  | "DELEGATE_COMMAND_NOT_FOUND"
  | "DELEGATE_COMMAND_START_FAILED"
  | "DELEGATE_NONZERO_EXIT"
  | "DELEGATE_EXECUTION_FAILED";

export interface DelegateCapabilityDescriptor {
  toolName: string;
  profileId: string;
  /** @reserved Public capability-inspection field consumed by host protocol clients. */
  profileName?: string;
  protocol: DelegateProtocol;
  /**
   * Preferred model ("provider/model") this delegate runs on, when the profile
   * declares one. Omitted when the delegate inherits the parent run's model.
   *
   * @reserved Public capability-inspection field consumed by routing/inspect UIs.
   */
  model?: string;
  risk: DelegateInvocationRisk;
  approvalRequiredUnderCurrentRun: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  approvalReasons: string[];
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  approvalRunOptions?: {
    shouldWrite?: boolean;
  };
  forbidNesting: boolean;
  sideEffects: string[];
  workspaceAccess: DelegateWorkspaceAccess;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  shellAccess: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  processSpawn: boolean;
  /**
   * True when the descriptor advertises profile-selected write/shell capability
   * that still requires the parent run to opt into workspace writes.
   *
   * @reserved Public capability-inspection field consumed by permission UIs.
   */
  gatedByRunWrite?: boolean;
  /**
   * Optional deterministic routing hint/evaluation. Present when the profile
   * declares `triggers` or `when.keywords`; `relevance` is present only after a
   * goal has been evaluated. This sorts/labels delegates but does not hide them.
   *
   * @reserved Public capability-inspection field consumed by routing/inspect UIs.
   */
  routing?: DelegateRoutingSummary;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  outputLimits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
  };
}

export type DelegateRoutingRelevance = "relevant" | "low";

export interface DelegateRoutingSummary {
  keywords: string[];
  mode?: "sort";
  relevance?: DelegateRoutingRelevance;
  score?: number;
  matchedKeywords?: string[];
  reason?: string;
}

export interface DelegateRoutingEvaluation extends DelegateRoutingSummary {
  toolName: string;
  profileId: string;
  mode: "sort";
  relevance: DelegateRoutingRelevance;
  score: number;
  matchedKeywords: string[];
  reason: string;
}

export interface DelegateRoutingPlan {
  delegates: CapabilityDelegateToolConfig[];
  routingByProfileId: Map<string, DelegateRoutingSummary>;
  evaluations: DelegateRoutingEvaluation[];
}

export interface DelegatePolicyProfile {
  policy: {
    risk: DelegateInvocationRisk;
    requiresApproval: boolean;
  };
  approvalRequiredUnderCurrentRun: boolean;
  approvalReasons: string[];
  approvalRunOptions?: {
    shouldWrite?: boolean;
  };
}

export function deriveDelegatePolicyProfile(input: {
  risk: DelegateInvocationRisk;
  configuredRequiresApproval?: boolean;
  defaultRequiresApproval: boolean;
  runWriteEnabled?: boolean;
}): DelegatePolicyProfile {
  const policy = {
    risk: input.risk,
    requiresApproval:
      input.configuredRequiresApproval ?? input.defaultRequiresApproval,
  };
  const approvalRequiredUnderCurrentRun =
    policy.risk === "risky" || policy.requiresApproval === true;
  const approvalReasons: string[] = [];

  if (policy.risk === "risky") {
    approvalReasons.push("tool.risk:risky");
  }
  if (policy.requiresApproval === true) {
    approvalReasons.push("tool.requiresApproval:true");
  }
  if (input.configuredRequiresApproval === true) {
    approvalReasons.push("delegate.requiresApproval:true");
  } else if (
    input.configuredRequiresApproval === false &&
    policy.risk === "risky"
  ) {
    approvalReasons.push("runtime.risk_gate_overrides_delegate_config:false");
  }

  return {
    policy,
    approvalRequiredUnderCurrentRun,
    approvalReasons: approvalRequiredUnderCurrentRun ? approvalReasons : [],
    ...(input.runWriteEnabled === undefined
      ? {}
      : { approvalRunOptions: { shouldWrite: input.runWriteEnabled } }),
  };
}

export class DelegateExecutionError extends Error {
  readonly code: DelegateFailureCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: DelegateFailureCode,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DelegateExecutionError";
    this.code = code;
    this.metadata = metadata;
  }
}

function currentSubagentDepth(
  metadata: Record<string, unknown> | undefined,
): number {
  const configured = metadata?.subagentDepth;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    return Math.floor(configured);
  }
  return typeof metadata?.parentRunId === "string" ? 1 : 0;
}

export function assertSubagentDepthAllowed(input: {
  parent: Pick<RunHandle, "record">;
  maxDepth?: number;
  toolName: string;
}): number {
  const nextDepth = currentSubagentDepth(input.parent.record.metadata) + 1;
  if (input.maxDepth !== undefined && nextDepth > input.maxDepth) {
    throw new DelegateExecutionError(
      "DELEGATE_EXECUTION_FAILED",
      `Delegate tool "${input.toolName}" exceeded capabilities.agents.maxDepth (${input.maxDepth}).`,
      {
        toolName: input.toolName,
        maxDepth: input.maxDepth,
        requestedDepth: nextDepth,
      },
    );
  }
  return nextDepth;
}

export function delegateToolName(
  delegate: Pick<CapabilityDelegateToolConfig, "profileId" | "toolName">,
): string {
  return (
    delegate.toolName ?? `delegate_${sanitizeToolSegment(delegate.profileId)}`
  );
}

/** The profile's preferred model as a string, when it declares one. */
function profileModelString(
  profile: Pick<AgentProfile, "model">,
): string | undefined {
  return typeof profile.model === "string" && profile.model.trim().length > 0
    ? profile.model.trim()
    : undefined;
}

/** Spreadable `{ model }` for a descriptor, omitted when the profile has none. */
function modelField(profile: Pick<AgentProfile, "model">): { model?: string } {
  const model = profileModelString(profile);
  return model ? { model } : {};
}

function routingField(profile: Pick<AgentProfile, "triggers" | "when">): {
  routing?: DelegateRoutingSummary;
} {
  const keywords = profileRoutingKeywords(profile);
  return keywords.length > 0 ? { routing: { keywords } } : {};
}

function profileRoutingKeywords(
  profile: Pick<AgentProfile, "triggers" | "when">,
): string[] {
  return uniqueStrings([
    ...(profile.triggers ?? []),
    ...(profile.when?.keywords ?? []),
  ]);
}

export function evaluateDelegateRouting(input: {
  goal: string;
  delegates: readonly CapabilityDelegateToolConfig[];
  profiles: readonly AgentProfile[];
}): DelegateRoutingPlan {
  const byProfile = new Map(
    input.profiles.map((profile) => [profile.id, profile]),
  );
  const candidates = input.delegates.map((delegate, index) => {
    const profile = byProfile.get(delegate.profileId);
    const keywords = profile ? profileRoutingKeywords(profile) : [];
    return { delegate, index, profile, keywords };
  });
  type Candidate = (typeof candidates)[number];
  const routed = candidates.filter(
    (candidate) =>
      candidate.profile !== undefined && candidate.keywords.length > 0,
  ) as Array<Candidate & { profile: AgentProfile }>;
  if (routed.length === 0) {
    return {
      delegates: [...input.delegates],
      routingByProfileId: new Map(),
      evaluations: [],
    };
  }

  const matches = matchSkills(
    input.goal,
    routed.map((candidate) => ({
      name: candidate.profile.id,
      description: [candidate.profile.name, candidate.profile.description]
        .filter((value): value is string => typeof value === "string")
        .join(" "),
      instructions: "",
      triggers: candidate.keywords,
    })),
    { includeZero: true, limit: routed.length },
  );
  const matchByProfileId = new Map(
    matches.map((match) => [match.skill.name, match]),
  );
  const routingByProfileId = new Map<string, DelegateRoutingSummary>();
  const evaluationByIndex = new Map<number, DelegateRoutingEvaluation>();

  for (const candidate of routed) {
    const match = matchByProfileId.get(candidate.profile.id);
    const score = match?.score ?? 0;
    const matchedKeywords = match?.matchedKeywords ?? [];
    const relevance: DelegateRoutingRelevance = score > 0 ? "relevant" : "low";
    const reason =
      relevance === "relevant"
        ? matchedKeywords.length > 0
          ? `matched ${matchedKeywords.join(", ")}`
          : "matched profile name or description"
        : "no routing keyword matched the current goal";
    const evaluation: DelegateRoutingEvaluation = {
      toolName: delegateToolName(candidate.delegate),
      profileId: candidate.profile.id,
      keywords: candidate.keywords,
      mode: "sort",
      relevance,
      score,
      matchedKeywords,
      reason,
    };
    routingByProfileId.set(candidate.profile.id, evaluation);
    evaluationByIndex.set(candidate.index, evaluation);
  }

  const sorted = [...candidates].sort((left, right) => {
    const leftRouting = left.profile
      ? routingByProfileId.get(left.profile.id)
      : undefined;
    const rightRouting = right.profile
      ? routingByProfileId.get(right.profile.id)
      : undefined;
    const leftRank = routingSortRank(leftRouting);
    const rightRank = routingSortRank(rightRouting);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (
      leftRouting?.relevance === "relevant" &&
      rightRouting?.relevance === "relevant" &&
      leftRouting.score !== rightRouting.score
    ) {
      return (rightRouting.score ?? 0) - (leftRouting.score ?? 0);
    }
    return left.index - right.index;
  });

  return {
    delegates: sorted.map((candidate) => candidate.delegate),
    routingByProfileId,
    evaluations: sorted
      .map((candidate) => evaluationByIndex.get(candidate.index))
      .filter((evaluation): evaluation is DelegateRoutingEvaluation =>
        Boolean(evaluation),
      ),
  };
}

export function delegateToolDescription(
  delegate: Pick<
    CapabilityDelegateToolConfig,
    "description" | "profileId" | "toolName"
  >,
  profile: Pick<AgentProfile, "id" | "name" | "description" | "model" | "use">,
): string {
  // An explicit author description is returned verbatim; only the generated
  // description is enriched with routing material (Phase 3a, pure text).
  if (delegate.description) return delegate.description;
  const label = profile.name ?? profile.id;
  const base =
    profile.description && profile.description.trim().length > 0
      ? `Delegate to ${label}: ${profile.description.trim()}`
      : `Delegate a bounded task to ${label}.`;
  const facets: string[] = [];
  const model = profileModelString(profile);
  if (model) facets.push(`model ${model}`);
  if (profile.use && profile.use.length > 0) {
    facets.push(`capabilities ${profile.use.join(", ")}`);
  }
  return facets.length > 0 ? `${base} (${facets.join("; ")})` : base;
}

/** How a resolved delegate tool was introduced, for collision diagnostics. */
export type DelegateToolSource = "config" | "inline" | "auto" | "builtin";

/**
 * A delegate tool that was dropped because its derived tool name collides with
 * one already claimed by another profile. Surfaced (never silently dropped) so
 * `review:foo` and `review/foo` — both sanitizing to `delegate_review_foo` —
 * fail closed instead of one silently winning.
 */
export interface DelegateToolCollision {
  toolName: string;
  /** The profile whose delegate tool was dropped. */
  profileId: string;
  /** The profile that already owns `toolName`. */
  conflictsWith: string;
  source: DelegateToolSource;
}

export interface ResolveAgentDelegateToolsOptions {
  /**
   * When true, synthesize a delegate target for every `mode in {child, all}`
   * profile that has no explicit delegate and is not opted out via
   * `exposeAsDelegate: false`. Use this for indexed/generic delegation
   * surfaces where callability is addressed by `agentId` instead of a named
   * tool.
   */
  includeAllChildProfiles?: boolean;
  /** Invoked once per dropped tool-name collision (fail-closed reporting). */
  onCollision?: (collision: DelegateToolCollision) => void;
}

export function resolveAgentDelegateTools(
  profiles: readonly AgentProfile[],
  configuredDelegates: readonly CapabilityDelegateToolConfig[] = [],
  options: ResolveAgentDelegateToolsOptions = {},
): CapabilityDelegateToolConfig[] {
  const resolved: CapabilityDelegateToolConfig[] = [];
  const ownerByToolName = new Map<string, string>();
  const claimedProfileIds = new Set<string>();

  const claim = (
    delegate: CapabilityDelegateToolConfig,
    source: DelegateToolSource,
  ): void => {
    const toolName = delegateToolName(delegate);
    const owner = ownerByToolName.get(toolName);
    if (owner !== undefined && owner !== delegate.profileId) {
      options.onCollision?.({
        toolName,
        profileId: delegate.profileId,
        conflictsWith: owner,
        source,
      });
      return;
    }
    resolved.push(delegate);
    ownerByToolName.set(toolName, delegate.profileId);
    claimedProfileIds.add(delegate.profileId);
  };

  // Explicit config wins: it is the precise layer and keeps authoring order.
  for (const delegate of configuredDelegates) {
    claim({ ...delegate }, "config");
  }
  // Inline `profile.delegateTool` folds under config; same-profile config
  // already claimed it, so skip (explicit wins, not a collision).
  for (const profile of profiles) {
    const inline = profile.delegateTool;
    if (!inline || claimedProfileIds.has(profile.id)) continue;
    claim({ profileId: profile.id, ...inline }, "inline");
  }
  // Auto-exposure (opt-in): child/all profiles with no explicit delegate.
  for (const profile of profiles) {
    if (claimedProfileIds.has(profile.id)) continue;
    if (profile.id === MAIN_AGENT_ID || profile.mode === "primary") continue;
    const expose =
      (options.includeAllChildProfiles === true &&
        profile.exposeAsDelegate !== false) ||
      profile.exposeAsDelegate === true;
    if (!expose) continue;
    claim({ profileId: profile.id }, "auto");
  }

  return resolved;
}

export type DirectDelegateExposureMode = "indexed" | "all";

export interface DirectDelegateExposureConfig {
  exposure?: DirectDelegateExposureMode;
  pinnedDelegates?: readonly string[];
}

export function directDelegateExposureMode(
  config: DirectDelegateExposureConfig | undefined,
): DirectDelegateExposureMode {
  return config?.exposure ?? "indexed";
}

export function filterDirectDelegatesForExposure<
  T extends Pick<CapabilityDelegateToolConfig, "profileId" | "toolName">,
>(
  delegates: readonly T[],
  config: DirectDelegateExposureConfig | undefined,
  profiles: readonly {
    id: string;
    exposeAsDelegate?: boolean;
  }[] = [],
): T[] {
  if (directDelegateExposureMode(config) === "all") return [...delegates];
  const pinned = new Set(config?.pinnedDelegates ?? []);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return delegates.filter((delegate) => {
    const toolName = delegateToolName(delegate);
    const profile = profileById.get(delegate.profileId);
    return (
      pinned.has(delegate.profileId) ||
      pinned.has(toolName) ||
      profile?.exposeAsDelegate === true
    );
  });
}

export function describeDelegateCapability(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  protocol: Exclude<DelegateProtocol, "in_process">;
  command: string;
  args?: string[];
  timeoutMs?: number;
  workspaceAccess?: DelegateWorkspaceAccess;
  allowReadWriteWorkspaceAccess?: boolean;
  outputLimits?: DelegateCapabilityDescriptor["outputLimits"];
  policyProfile?: DelegatePolicyProfile;
  routing?: DelegateRoutingSummary;
}): DelegateCapabilityDescriptor {
  const policyProfile =
    input.policyProfile ??
    deriveDelegatePolicyProfile({
      risk: "risky",
      configuredRequiresApproval: input.delegate.requiresApproval,
      defaultRequiresApproval: true,
      runWriteEnabled: input.allowReadWriteWorkspaceAccess,
    });
  const approval = delegatePolicyProfileApprovalFacts(policyProfile);
  return {
    toolName: delegateToolName(input.delegate),
    profileId: input.profile.id,
    profileName: input.profile.name,
    protocol: input.protocol,
    ...modelField(input.profile),
    ...routingSummary(input.profile, input.routing),
    risk: policyProfile.policy.risk,
    ...approval,
    forbidNesting: input.delegate.forbidNesting ?? true,
    sideEffects: ["external"],
    workspaceAccess: input.workspaceAccess ?? "none",
    shellAccess: false,
    processSpawn: true,
    command: input.command,
    args: input.args ?? [],
    timeoutMs: input.timeoutMs,
    outputLimits: input.outputLimits,
  };
}

export function describeInProcessDelegateCapability(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  workspaceAccess: DelegateWorkspaceAccess;
  shellAccess: boolean;
  gatedByRunWrite?: boolean;
  allowReadWriteWorkspaceAccess?: boolean;
  policyProfile?: DelegatePolicyProfile;
  routing?: DelegateRoutingSummary;
}): DelegateCapabilityDescriptor {
  const policyProfile =
    input.policyProfile ??
    deriveDelegatePolicyProfile({
      risk: "safe",
      configuredRequiresApproval: input.delegate.requiresApproval,
      defaultRequiresApproval: false,
      runWriteEnabled: input.allowReadWriteWorkspaceAccess,
    });
  const approval = delegatePolicyProfileApprovalFacts(policyProfile);
  return {
    toolName: delegateToolName(input.delegate),
    profileId: input.profile.id,
    profileName: input.profile.name,
    protocol: "in_process",
    ...modelField(input.profile),
    ...routingSummary(input.profile, input.routing),
    risk: policyProfile.policy.risk,
    ...approval,
    forbidNesting: input.delegate.forbidNesting ?? true,
    sideEffects: [
      "model",
      ...(input.workspaceAccess === "read_write" ? ["workspace"] : []),
      ...(input.shellAccess ? ["shell"] : []),
    ],
    workspaceAccess: input.workspaceAccess,
    shellAccess: input.shellAccess,
    processSpawn: false,
    gatedByRunWrite: input.gatedByRunWrite,
  };
}

function delegatePolicyProfileApprovalFacts(
  policyProfile: DelegatePolicyProfile,
): Pick<
  DelegateCapabilityDescriptor,
  "approvalRequiredUnderCurrentRun" | "approvalReasons" | "approvalRunOptions"
> {
  const facts: Pick<
    DelegateCapabilityDescriptor,
    "approvalRequiredUnderCurrentRun" | "approvalReasons"
  > = {
    approvalRequiredUnderCurrentRun:
      policyProfile.approvalRequiredUnderCurrentRun,
    approvalReasons: policyProfile.approvalReasons,
  };
  return policyProfile.approvalRunOptions === undefined
    ? facts
    : { ...facts, approvalRunOptions: policyProfile.approvalRunOptions };
}

function routingSummary(
  profile: Pick<AgentProfile, "id" | "triggers" | "when">,
  routing?: DelegateRoutingSummary,
): { routing?: DelegateRoutingSummary } {
  return routing ? { routing } : routingField(profile);
}

function routingSortRank(routing: DelegateRoutingSummary | undefined): number {
  if (!routing?.relevance) return 1;
  return routing.relevance === "relevant" ? 0 : 2;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function describeExternalDelegateCapability(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
}): DelegateCapabilityDescriptor | undefined {
  const acp = recordField(input.profile.metadata, "acp");
  if (
    acp?.transport === "stdio" &&
    typeof acp.command === "string" &&
    acp.command.length > 0
  ) {
    return describeDelegateCapability({
      delegate: input.delegate,
      profile: input.profile,
      protocol: "acp",
      command: acp.command,
      args: stringArrayField(acp, "args"),
      timeoutMs: numberField(acp, "timeoutMs"),
      workspaceAccess: workspaceAccessField(acp) ?? "none",
    });
  }
  const externalCommand = recordField(
    input.profile.metadata,
    "externalCommand",
  );
  if (
    typeof externalCommand?.command === "string" &&
    externalCommand.command.length > 0
  ) {
    const maxOutputBytes = numberField(externalCommand, "maxOutputBytes");
    return describeDelegateCapability({
      delegate: input.delegate,
      profile: input.profile,
      protocol: "external_command",
      command: externalCommand.command,
      args: stringArrayField(externalCommand, "args"),
      timeoutMs: numberField(externalCommand, "timeoutMs"),
      workspaceAccess: workspaceAccessField(externalCommand) ?? "none",
      outputLimits: {
        stdoutBytes:
          numberField(externalCommand, "maxStdoutBytes") ?? maxOutputBytes,
        stderrBytes:
          numberField(externalCommand, "maxStderrBytes") ?? maxOutputBytes,
      },
    });
  }
  return undefined;
}

export function workspaceAccessField(
  record: Record<string, unknown>,
): DelegateWorkspaceAccess | undefined {
  return record.workspaceAccess === "read_write" ? "read_write" : undefined;
}

export function assertWorkspaceAccess(input: {
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
  reason: "cwd" | "workspaceRoot";
}): void {
  if (input.workspaceAccess === "read_write") return;
  const detail =
    input.reason === "cwd"
      ? "metadata cwd"
      : "{{workspaceRoot}} argument expansion";
  throw new DelegateExecutionError(
    "DELEGATE_WORKSPACE_ACCESS_DENIED",
    `Delegate tool "${input.toolName}" requires workspaceAccess "read_write" before using ${detail}.`,
    { toolName: input.toolName, reason: input.reason },
  );
}

export function assertReadWriteWorkspaceAccessAllowed(input: {
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
  allowed: boolean;
}): void {
  if (input.workspaceAccess !== "read_write" || input.allowed) return;
  throw new DelegateExecutionError(
    "DELEGATE_WORKSPACE_ACCESS_DENIED",
    `Delegate tool "${input.toolName}" requests workspaceAccess "read_write", but the parent run has not enabled workspace writes.`,
    {
      toolName: input.toolName,
      workspaceAccess: input.workspaceAccess,
      reason: "parent_write_disabled",
    },
  );
}

export async function resolveDelegateProcessWorkspace(input: {
  workspaceRoot: string;
  configuredCwd?: string;
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
}): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  if (input.workspaceAccess === "read_write") {
    return {
      cwd: input.configuredCwd
        ? resolve(input.workspaceRoot, input.configuredCwd)
        : input.workspaceRoot,
      async cleanup() {},
    };
  }
  if (input.configuredCwd) {
    assertWorkspaceAccess({
      workspaceAccess: input.workspaceAccess,
      toolName: input.toolName,
      reason: "cwd",
    });
  }
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-delegate-"));
  return {
    cwd,
    async cleanup() {
      // `maxRetries`/`retryDelay` let Node retry the recursive remove on
      // Windows, where a just-exited delegate child can still briefly hold a
      // handle on the temp dir and make the first `rmdir` throw EBUSY/EPERM.
      await rm(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}

export function usesWorkspaceRootTemplate(
  values: string[] | undefined,
): boolean {
  return (values ?? []).some((value) => value.includes("{{workspaceRoot}}"));
}

export function errorCode(error: unknown): DelegateFailureCode {
  if (error instanceof DelegateExecutionError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    if (isDelegateFailureCode(code)) return code;
  }
  return "DELEGATE_EXECUTION_FAILED";
}

/**
 * Canonical tool-name segment sanitizer. Collapses any run of characters
 * outside `[A-Za-z0-9_.-]` to a single `_` and trims leading/trailing `_`.
 * This is the single source of truth for delegate (and dynamic agent) tool
 * names — runtime.ts imports this rather than keeping a second, divergent
 * sanitizer, so collision detection sees one canonical form.
 */
export function sanitizeToolSegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function isDelegateFailureCode(value: string): value is DelegateFailureCode {
  return (
    value === "DELEGATE_APPROVAL_DENIED" ||
    value === "DELEGATE_WORKSPACE_ACCESS_DENIED" ||
    value === "DELEGATE_TIMEOUT" ||
    value === "DELEGATE_COMMAND_NOT_FOUND" ||
    value === "DELEGATE_COMMAND_START_FAILED" ||
    value === "DELEGATE_NONZERO_EXIT" ||
    value === "DELEGATE_EXECUTION_FAILED"
  );
}

function recordField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === "object"
    ? (item as Record<string, unknown>)
    : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
