// AI maintenance note: Tools are LLM-invoked actions (gated by policy +
// approval). User-typed slash commands live in commands.ts (CommandRegistry).
// Wire via `defineTool` + `createRun({ tools })`.
import { createToolCallId } from "./ids.js";
import type { RunId } from "./ids.js";
import type {
  RuntimeContext,
  SparkwrightError,
  ToolCall,
  ToolResult,
} from "./types.js";
import { isRecord } from "./record-utils.js";

export type ToolRisk = "safe" | "risky" | "denied";
export type ToolSideEffect = "none" | "read" | "write" | "network" | "external";
export type ToolIdempotency = "idempotent" | "conditional" | "non_idempotent";
export type ToolDataSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "secret";

export interface ToolRateLimit {
  maxCalls: number;
  windowMs: number;
}

export interface ToolAuditPolicy {
  level: "none" | "metadata" | "payload";
  retentionDays?: number;
  viewers?: string[];
}

export interface ToolCostEstimate {
  tier?: "free" | "low" | "medium" | "high";
  estimatedTokens?: number;
  estimatedUsd?: number;
}

export type ToolInterruptBehavior = "cancel" | "block";

/**
 * Cheap environment probe deciding whether a tool is currently usable.
 * Resolving false withholds the tool from model-facing descriptors; it never
 * reaches the provider request. Must not depend on per-call arguments — results
 * are TTL-cached and shared across calls.
 */
export type ToolAvailableProbe = () => boolean | Promise<boolean>;

export interface ToolResultSizePolicy {
  /**
   * Maximum serialized result size before an embedder should materialize the
   * full output as an artifact and return a preview to the model.
   */
  maxChars?: number;
  /**
   * When true, the runtime should never spill this tool's result to an
   * artifact automatically. Use for tools whose output already has a bounded,
   * replay-safe shape.
   *
   * @reserved Public descriptor field consumed by artifact stores and UIs.
   */
  neverPersist?: boolean;
}

export type ToolResultPresentationKind =
  | "file_discovery"
  | "file_read"
  | "text_search"
  | "shell_output"
  | "diagnostic"
  | "generic";

export interface ToolResultPresentation {
  /**
   * Semantic result class used by observation formatters and UIs when deciding
   * what must stay visible to the model.
   */
  kind: ToolResultPresentationKind;
  /**
   * Top-level result fields that should be kept intact when they fit the
   * observation budget. Examples: paths, matches, errors, exitCode.
   *
   * @reserved Public presentation field consumed by observation formatters.
   */
  preserveFields?: string[];
  /**
   * Names of pagination / recovery fields emitted by this tool.
   *
   * @reserved Public presentation field consumed by observation formatters.
   */
  paginationFields?: string[];
  /**
   * Hint for large raw output handling. Concrete materialization is still owned
   * by the tool or embedding runtime.
   *
   * @reserved Public presentation field consumed by artifact-aware UIs.
   */
  artifactPolicy?: "when_large" | "on_failure" | "never";
}

export interface ToolRequestPreviewOptions {
  maxChars: number;
}

export type ToolRequestPreviewFormatter<TArgs = unknown> = (
  args: TArgs,
  options: ToolRequestPreviewOptions,
) => string | undefined;

export type ToolApprovalSummaryFormatter<TArgs = unknown> = (
  args: TArgs,
  options: ToolRequestPreviewOptions,
) => string | undefined;

export type ToolInputValidationResult =
  | { ok: true }
  | {
      ok: false;
      code?: string;
      message: string;
      metadata?: Record<string, unknown>;
    };

export interface ToolProgressUpdate {
  /** @reserved Public progress payload field consumed by streaming UIs. */
  label?: string;
  message?: string;
  /** @reserved Public progress payload field consumed by streaming UIs. */
  completedUnits?: number;
  /** @reserved Public progress payload field consumed by streaming UIs. */
  totalUnits?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolOrigin {
  kind: "local" | "script" | "mcp" | "hosted" | "unknown";
  name?: string;
  metadata?: Record<string, unknown>;
}

export type ToolExposureTier =
  | "public"
  | "advanced"
  | "infrastructure"
  | "internal"
  | "legacy";

export interface ToolGovernance {
  allowedAgents?: string[];
  allowedRoles?: string[];
  origin?: ToolOrigin;
  rateLimit?: ToolRateLimit;
  dataSensitivity?: ToolDataSensitivity;
  sideEffects?: ToolSideEffect[];
  idempotency?: ToolIdempotency;
  audit?: ToolAuditPolicy;
  costEstimate?: ToolCostEstimate;
}

export type ToolInputSchema = {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
  properties?: Record<string, ToolInputSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolInputSchema;
  enum?: unknown[];
};

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  canonicalName?: string;
  legacyNames?: string[];
  defaultExposureTier?: ToolExposureTier;
  relatedTools?: string[];
  requiresTool?: string[];
  timeoutMs?: number;
  /**
   * @reserved Public descriptor field consumed by tool schedulers and UIs.
   */
  concurrency?: {
    safe?: boolean;
  };
  /**
   * @reserved Public descriptor field consumed by streaming UIs and run
   * controllers when a new user command arrives during tool execution.
   */
  interrupt?: {
    behavior?: ToolInterruptBehavior;
  };
  /**
   * @reserved Public descriptor field consumed by prompt/tool loaders. Deferred
   * tools can be omitted from the initial model request and discovered later.
   */
  loading?: {
    defer?: boolean;
    alwaysLoad?: boolean;
  };
  /**
   * @reserved Public descriptor field consumed by artifact stores and UIs.
   */
  resultSize?: ToolResultSizePolicy;
  resultPresentation?: ToolResultPresentation;
  policy?: {
    risk?: ToolRisk;
    requiresApproval?: boolean;
  };
  governance?: ToolGovernance;
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  /**
   * Stable product-facing identity. `name` is the callable name currently
   * offered to the model; `canonicalName` lets display/config/history code
   * share one identity record while old names remain parseable.
   */
  canonicalName?: string;
  legacyNames?: string[];
  defaultExposureTier?: ToolExposureTier;
  relatedTools?: string[];
  requiresTool?: string[];
  timeoutMs?: number;
  interruptBehavior?: ToolInterruptBehavior | (() => ToolInterruptBehavior);
  /**
   * Hint for embedders that need to keep model observations compact. The core
   * descriptor exposes this policy; concrete artifact materialization remains
   * owned by the embedding runtime until the storage contract is promoted.
   */
  resultSize?: ToolResultSizePolicy;
  resultPresentation?: ToolResultPresentation;
  /**
   * Tool-owned one-line request summary for live UIs and trace projections.
   * The run loop calls this before execution and stores the bounded text on
   * `tool.requested.payload.preview`, so renderers do not need a growing
   * switch statement for every tool name.
   */
  previewArgs?(
    args: TArgs,
    options: ToolRequestPreviewOptions,
  ): string | undefined;
  /**
   * Tool-owned approval summary for argument-dependent capability grants. When
   * omitted, the run loop keeps the generic "Run tool <name>" summary.
   */
  approvalSummaryForArgs?(
    args: TArgs,
    options: ToolRequestPreviewOptions,
  ): string | undefined;
  /**
   * Optional corrective guidance when the generic repeat guard skips a
   * verbatim state-observation call. Returning text makes the skip a completed
   * no-op rather than a synthetic tool failure; the tool is still not executed.
   */
  repeatedCallGuidanceForArgs?(args: TArgs): string | undefined;
  /**
   * When true, a tool loader may hide this tool from the initial provider
   * request and expose it through a discovery/search surface.
   */
  deferLoading?: boolean;
  /**
   * Forces eager loading even when a product shell enables deferred tools.
   */
  alwaysLoad?: boolean;
  policy?: {
    risk?: ToolRisk;
    requiresApproval?: boolean;
  };
  governance?: ToolGovernance;
  /**
   * Optional per-call policy override for wrapper tools whose action argument
   * mixes read-only and mutating operations.
   */
  policyForArgs?(args: TArgs): {
    policy?: ToolDefinition<TArgs, TResult>["policy"];
    governance?: ToolGovernance;
  };
  /**
   * Optional semantic input validation that runs after JSON schema validation
   * and before policy/approval. It must not mutate args, write the workspace,
   * create artifacts, or call external networks; use it for "can this input
   * make sense for this tool?" checks, not risk classification.
   */
  validateInput?(
    args: TArgs,
    ctx: RuntimeContext,
  ): ToolInputValidationResult | Promise<ToolInputValidationResult>;
  /**
   * Optional runtime availability probe. When provided and it resolves false,
   * the tool is withheld from model-facing descriptors (it never appears in the
   * provider request) instead of failing at call time. Use for tools gated on
   * live environment state: an OAuth token or credential present, a binary
   * installed, a gateway reachable. Must be a cheap check that does not depend
   * on per-call arguments — results are TTL-cached (default 30s) and shared
   * across calls; call {@link ToolRegistry.invalidateAvailability} after config
   * changes that affect it. A probe that throws is treated as unavailable.
   */
  available?: ToolAvailableProbe;
  isConcurrencySafe?(args: TArgs): boolean;
  /**
   * Whether re-invoking this tool with the same args after a transient
   * failure is safe (no double-spend, no duplicated mutation).
   *
   * - `undefined` (default): unknown — runtime treats as safe to preserve
   *   backward compatibility with existing tools.
   * - `true`: idempotent or read-only — runtime / model may freely retry.
   * - `false`: caller-visible side effect (HTTP POST, payment, IM send,
   *   external API mutation). On a network-class failure the runtime
   *   emits a `tool.replay_risk` event and annotates the ToolResult so
   *   the model and host can choose to pause for confirmation instead of
   *   silently re-running.
   */
  isReplaySafe?: boolean;
  /** @reserved Public tool-governance hint consumed by policy adapters. */
  isReadOnly?(args: TArgs): boolean;
  /** @reserved Public tool-governance hint consumed by policy adapters. */
  isDestructive?(args: TArgs): boolean;
  /** @reserved Public permission matcher hook consumed by policy adapters. */
  preparePermissionMatcher?(args: TArgs): Promise<(pattern: string) => boolean>;
  execute(args: TArgs, ctx: RuntimeContext): Promise<TResult> | TResult;
}

export function defineTool<TArgs = unknown, TResult = unknown>(
  tool: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  return tool;
}

export interface ToolRegistryOptions {
  /**
   * How long a tool's {@link ToolDefinition.available} probe result is cached
   * before re-evaluation. Defaults to 30 000ms.
   */
  availabilityTtlMs?: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly aliases = new Map<string, string>();
  private generation = 0;
  private readonly availabilityTtlMs: number;
  // Keyed by the probe function reference so identical probes shared across
  // tools (e.g. one OAuth check for every tool from a server) are evaluated
  // once per TTL window.
  private readonly availabilityCache = new Map<
    ToolAvailableProbe,
    { expiresAt: number; value: boolean }
  >();
  // In-flight evaluations, so concurrent callers (and multiple tools sharing a
  // probe inside one `Promise.all` pass) collapse onto a single invocation.
  private readonly availabilityInflight = new Map<
    ToolAvailableProbe,
    Promise<boolean>
  >();

  constructor(options: ToolRegistryOptions = {}) {
    this.availabilityTtlMs = options.availabilityTtlMs ?? 30_000;
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name) || this.aliases.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    for (const alias of tool.legacyNames ?? []) {
      if (alias === tool.name) continue;
      if (this.tools.has(alias) || this.aliases.has(alias)) {
        throw new Error(`Tool alias already registered: ${alias}`);
      }
    }

    this.tools.set(tool.name, tool);
    this.registerAliases(tool);
    this.generation += 1;
  }

  unregister(name: string): boolean {
    const canonicalName = this.aliases.get(name) ?? name;
    const existing = this.tools.get(canonicalName);
    const removed = this.tools.delete(canonicalName);
    if (removed) {
      this.unregisterAliases(canonicalName, existing);
      this.generation += 1;
      this.dropAvailabilityEntry(existing);
    }
    return removed;
  }

  replace(tool: ToolDefinition): void {
    const existing = this.tools.get(tool.name);
    if (existing && existing.available !== tool.available) {
      this.dropAvailabilityEntry(existing);
    }
    this.unregisterAliases(tool.name, existing);
    this.tools.set(tool.name, tool);
    this.registerAliases(tool);
    this.generation += 1;
  }

  getGeneration(): number {
    return this.generation;
  }

  snapshot(): { generation: number; tools: ToolDefinition[] } {
    return {
      generation: this.generation,
      tools: this.list(),
    };
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name) ?? this.tools.get(this.aliases.get(name) ?? "");
  }

  /**
   * Resolve a callable legacy name to the registered tool name. Unknown names
   * are returned unchanged so callers can report the original lookup failure.
   * Policy and workflow layers should consume this value instead of each
   * implementing their own alias table.
   */
  canonicalName(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Descriptors for every registered tool, ignoring availability. Use for
   * enumeration, auditing, and UIs. Model-facing code should prefer
   * {@link ToolRegistry.listModelDescriptors}.
   */
  listDescriptors(): ToolDescriptor[] {
    return this.list().map((tool) => toToolDescriptor(tool));
  }

  /**
   * Evaluate a single tool's availability probe, TTL-cached. Tools without a
   * probe are always available. A probe that throws is treated as unavailable
   * (fail safe — a tool that cannot confirm its prerequisites is hidden rather
   * than offered and failed at call time).
   */
  async isAvailable(tool: ToolDefinition): Promise<boolean> {
    const probe = tool.available;
    if (!probe) return true;

    const cached = this.availabilityCache.get(probe);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const inflight = this.availabilityInflight.get(probe);
    if (inflight) return inflight;

    const pending = (async () => {
      let value: boolean;
      try {
        value = await probe();
      } catch {
        value = false;
      }
      this.availabilityCache.set(probe, {
        expiresAt: Date.now() + this.availabilityTtlMs,
        value,
      });
      return value;
    })();
    this.availabilityInflight.set(probe, pending);
    void pending.finally(() => {
      if (this.availabilityInflight.get(probe) === pending) {
        this.availabilityInflight.delete(probe);
      }
    });
    return pending;
  }

  /** Registered tools whose availability probe currently resolves true. */
  async listAvailableTools(): Promise<ToolDefinition[]> {
    const tools = this.list();
    const flags = await Promise.all(
      tools.map((tool) => this.isAvailable(tool)),
    );
    return tools.filter((_, index) => flags[index]);
  }

  /**
   * Descriptors for the tools that should be offered to the model right now:
   * every registered tool minus those whose availability probe resolves false.
   */
  async listModelDescriptors(): Promise<ToolDescriptor[]> {
    const available = await this.listAvailableTools();
    return available.map((tool) => toToolDescriptor(tool));
  }

  /**
   * Drop all cached availability results, forcing the next probe evaluation.
   * Call after configuration changes that affect tool prerequisites (e.g. an
   * OAuth flow completing, a credential being added).
   */
  invalidateAvailability(): void {
    this.availabilityCache.clear();
    this.availabilityInflight.clear();
  }

  private dropAvailabilityEntry(tool: ToolDefinition | undefined): void {
    if (tool?.available) this.availabilityCache.delete(tool.available);
  }

  private registerAliases(tool: ToolDefinition): void {
    for (const alias of tool.legacyNames ?? []) {
      if (alias !== tool.name) this.aliases.set(alias, tool.name);
    }
  }

  private unregisterAliases(
    canonicalName: string,
    tool: ToolDefinition | undefined,
  ): void {
    for (const alias of tool?.legacyNames ?? []) {
      if (this.aliases.get(alias) === canonicalName) {
        this.aliases.delete(alias);
      }
    }
  }
}

function toToolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    canonicalName: tool.canonicalName,
    legacyNames: tool.legacyNames,
    defaultExposureTier: tool.defaultExposureTier,
    relatedTools: tool.relatedTools,
    requiresTool: tool.requiresTool,
    timeoutMs: tool.timeoutMs,
    concurrency: {
      safe: isToolConcurrencySafe(tool),
    },
    interrupt: {
      behavior: getToolInterruptBehavior(tool),
    },
    loading: {
      defer: tool.deferLoading,
      alwaysLoad: tool.alwaysLoad,
    },
    resultSize: tool.resultSize,
    resultPresentation: tool.resultPresentation,
    policy: tool.policy,
    governance: tool.governance,
  };
}

export function formatToolRequestPreview(
  tool: ToolDefinition | undefined,
  args: unknown,
  maxChars = 160,
): string | undefined {
  if (!tool?.previewArgs || maxChars < 8) return undefined;
  try {
    return boundToolRequestPreview(
      tool.previewArgs(args, { maxChars }),
      maxChars,
    );
  } catch {
    return undefined;
  }
}

export function formatToolApprovalSummary(
  tool: ToolDefinition | undefined,
  args: unknown,
  maxChars = 200,
): string | undefined {
  if (!tool?.approvalSummaryForArgs || maxChars < 8) return undefined;
  try {
    return boundToolRequestPreview(
      tool.approvalSummaryForArgs(args, { maxChars }),
      maxChars,
    );
  } catch {
    return undefined;
  }
}

function boundToolRequestPreview(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const preview = stripAnsi(value)
    .replace(/\\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!preview) return undefined;
  return preview.length > maxChars
    ? `${preview.slice(0, Math.max(0, maxChars - 1))}…`
    : preview;
}

function stripAnsi(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
    "",
  );
}

export function getToolInterruptBehavior(
  tool: ToolDefinition | ToolDescriptor | undefined,
): ToolInterruptBehavior | undefined {
  if (!tool || !("interruptBehavior" in tool)) return undefined;
  const behavior = tool.interruptBehavior;
  return typeof behavior === "function" ? behavior() : behavior;
}

export function isToolConcurrencySafe(
  tool: ToolDefinition | ToolDescriptor | undefined,
  args?: unknown,
): boolean {
  if (!tool) return false;
  if (
    "isConcurrencySafe" in tool &&
    typeof tool.isConcurrencySafe === "function"
  ) {
    return tool.isConcurrencySafe(args as never);
  }
  // Argument-dependent policy can strengthen a statically read-only tool into
  // a risky or mutating call. Without an explicit per-argument concurrency
  // classifier, scheduling it concurrently would happen before that stronger
  // policy is resolved by the execution gate. Fail closed to serial execution.
  if ("policyForArgs" in tool && typeof tool.policyForArgs === "function") {
    return false;
  }
  if (tool.policy?.risk === "risky" || tool.policy?.risk === "denied") {
    return false;
  }
  if (tool.policy?.requiresApproval === true) return false;

  const sideEffects = tool.governance?.sideEffects ?? ["none"];
  const readOnly = sideEffects.every(
    (sideEffect) => sideEffect === "none" || sideEffect === "read",
  );
  if (!readOnly) return false;

  return tool.governance?.idempotency !== "non_idempotent";
}

export function validateToolArguments(
  schema: unknown,
  value: unknown,
): SparkwrightError | undefined {
  const message = validateJsonSchema(schema, value, "$");

  if (!message) return undefined;

  return {
    code: "TOOL_ARGUMENTS_INVALID",
    message,
  };
}

export function validateToolOutput(
  schema: unknown,
  value: unknown,
): SparkwrightError | undefined {
  const message = validateJsonSchema(schema, value, "$");

  if (!message) return undefined;

  return {
    code: "TOOL_OUTPUT_INVALID",
    message,
  };
}

export function createToolCall(
  runId: RunId,
  toolName: string,
  args: unknown,
): ToolCall {
  return {
    id: createToolCallId(),
    runId,
    toolName,
    arguments: args,
  };
}

export async function executeTool(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: RuntimeContext,
  options: { timeoutMs?: number; abortSignal?: AbortSignal } = {},
): Promise<ToolResult> {
  const tool = registry.get(call.toolName);

  if (!tool) {
    return {
      toolCallId: call.id,
      status: "failed",
      error: {
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${call.toolName}`,
      },
      artifacts: [],
    };
  }

  const signal = options.abortSignal ?? ctx.abortSignal;
  if (signal?.aborted) {
    return {
      toolCallId: call.id,
      status: "cancelled",
      error: {
        code: "TOOL_ABORTED",
        message: `Tool aborted before execution: ${call.toolName}`,
        metadata: { toolName: call.toolName },
      },
      artifacts: [],
    };
  }

  try {
    const validationError = validateToolArguments(
      tool.inputSchema,
      call.arguments,
    );

    if (validationError) {
      return {
        toolCallId: call.id,
        status: "failed",
        error: validationError,
        artifacts: [],
      };
    }

    const timeoutMs = tool.timeoutMs ?? options.timeoutMs;
    const timeoutError = validateToolTimeout(timeoutMs, call.toolName);

    if (timeoutError) {
      return {
        toolCallId: call.id,
        status: "failed",
        error: timeoutError,
        artifacts: [],
      };
    }

    // Forward the abort signal into the runtime context so tools that honor it
    // can wire their inner I/O (fetch, child_process, ...) to the run-level
    // cancellation. Tools which ignore the signal still get torn down at the
    // race below.
    const artifacts: ToolResult["artifacts"] = [];
    const ctxWithSignal: RuntimeContext = {
      ...ctx,
      abortSignal: signal,
      reportToolArtifact: (artifact) => {
        artifacts.push(artifact);
        ctx.reportToolArtifact?.(artifact);
      },
    };

    const output = await executeWithTimeout(
      () => tool.execute(call.arguments, ctxWithSignal),
      timeoutMs,
      call.toolName,
      signal,
    );

    const outputValidationError = validateToolOutput(tool.outputSchema, output);

    if (outputValidationError) {
      return {
        toolCallId: call.id,
        status: "failed",
        error: outputValidationError,
        artifacts: [],
      };
    }

    return {
      toolCallId: call.id,
      status: "completed",
      output,
      artifacts,
    };
  } catch (cause) {
    if (cause instanceof ToolTimeoutError) {
      return {
        toolCallId: call.id,
        status: "failed",
        error: {
          code: "TOOL_TIMEOUT",
          message: cause.message,
          cause,
          metadata: cause.metadata,
        },
        artifacts: [],
      };
    }

    if (isAbortError(cause) || signal?.aborted) {
      return {
        toolCallId: call.id,
        status: "cancelled",
        error: {
          code: "TOOL_ABORTED",
          message: `Tool aborted: ${call.toolName}`,
          metadata: { toolName: call.toolName },
        },
        artifacts: [],
      };
    }

    return {
      toolCallId: call.id,
      status: "failed",
      error: normalizeToolError(cause),
      artifacts: [],
    };
  }
}

function isAbortError(cause: unknown): boolean {
  if (cause instanceof Error) {
    if (cause.name === "AbortError") return true;
    const code = (cause as { code?: string }).code;
    if (code === "ABORT_ERR" || code === "ERR_ABORTED") return true;
  }
  return false;
}

export function normalizeToolError(
  cause: unknown,
  fallback: { code: string; message: string } = {
    code: "TOOL_EXECUTION_FAILED",
    message: "Tool execution failed.",
  },
): SparkwrightError {
  if (isRecord(cause) && typeof cause.code === "string") {
    return {
      code: cause.code,
      message:
        typeof cause.message === "string" ? cause.message : fallback.message,
      cause,
      metadata: isRecord(cause.metadata) ? cause.metadata : undefined,
    };
  }

  return {
    code: fallback.code,
    message: cause instanceof Error ? cause.message : fallback.message,
    cause,
  };
}

function validateToolTimeout(
  timeoutMs: number | undefined,
  toolName: string,
): SparkwrightError | undefined {
  if (timeoutMs === undefined) return undefined;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return {
      code: "TOOL_TIMEOUT_INVALID",
      message: `Tool timeout must be a positive integer in milliseconds for tool: ${toolName}`,
      metadata: { toolName, timeoutMs },
    };
  }

  return undefined;
}

async function executeWithTimeout<TResult>(
  execute: () => Promise<TResult> | TResult,
  timeoutMs: number | undefined,
  toolName: string,
  signal?: AbortSignal,
): Promise<TResult> {
  if (timeoutMs === undefined && !signal) return execute();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const racers: Array<Promise<TResult>> = [Promise.resolve().then(execute)];
    if (timeoutMs !== undefined) {
      racers.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new ToolTimeoutError(toolName, timeoutMs));
          }, timeoutMs);
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(createAbortError());
            return;
          }
          onAbort = () => reject(createAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function createAbortError(): Error {
  const err = new Error("Tool operation aborted.");
  err.name = "AbortError";
  return err;
}

class ToolTimeoutError extends Error {
  readonly metadata: Record<string, unknown>;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs}ms: ${toolName}`);
    this.name = "ToolTimeoutError";
    this.metadata = { toolName, timeoutMs };
  }
}

function validateJsonSchema(
  schema: unknown,
  value: unknown,
  path: string,
): string | undefined {
  if (!isRecord(schema)) return undefined;

  const type = schema.type;
  if (typeof type === "string") {
    const typeError = validateType(type, value, path);
    if (typeError) return typeError;
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum))
      return `${path}: enum must be an array in schema.`;
    if (!schema.enum.includes(value))
      return `${path}: value is not one of the allowed enum values.`;
  }

  if (
    type === "object" ||
    schema.properties ||
    schema.required ||
    schema.additionalProperties !== undefined
  ) {
    if (!isRecord(value)) return `${path}: expected object.`;

    const required = schema.required;
    if (required !== undefined) {
      if (!Array.isArray(required))
        return `${path}: required must be an array in schema.`;

      for (const key of required) {
        if (typeof key !== "string")
          return `${path}: required entries must be strings in schema.`;
        if (!(key in value))
          return `${path}.${key}: required property is missing.`;
      }
    }

    const properties = schema.properties;
    if (properties !== undefined) {
      if (!isRecord(properties))
        return `${path}: properties must be an object in schema.`;

      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in value) {
          const nestedError = validateJsonSchema(
            propertySchema,
            value[key],
            `${path}.${key}`,
          );
          if (nestedError) return nestedError;
        }
      }
    }

    if (schema.additionalProperties === false && isRecord(properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in properties))
          return `${path}.${key}: additional property is not allowed.`;
      }
    }
  }

  if (type === "array" || schema.items) {
    if (!Array.isArray(value)) return `${path}: expected array.`;

    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateJsonSchema(
          schema.items,
          value[index],
          `${path}[${index}]`,
        );
        if (nestedError) return nestedError;
      }
    }
  }

  return undefined;
}

function validateType(
  type: string,
  value: unknown,
  path: string,
): string | undefined {
  switch (type) {
    case "array":
      return Array.isArray(value) ? undefined : `${path}: expected array.`;
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `${path}: expected boolean.`;
    case "integer":
      return Number.isInteger(value) ? undefined : `${path}: expected integer.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${path}: expected number.`;
    case "object":
      return isRecord(value) ? undefined : `${path}: expected object.`;
    case "string":
      return typeof value === "string"
        ? undefined
        : `${path}: expected string.`;
    case "null":
      return value === null ? undefined : `${path}: expected null.`;
    default:
      return undefined;
  }
}
