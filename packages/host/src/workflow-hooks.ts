import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isAbsolute, resolve } from "node:path";
import {
  createBufferedEmitter,
  createContextItemId,
  bindUserHooks,
  type ContextItem,
  type ProcessInvocationBase,
  type ProcessOutputSummary,
  type RunHandle,
  type RuntimeContext,
  type SandboxSummary,
  type SparkwrightEvent,
  type ToolDefinition,
  type UserHookOutcome,
  type UserHookRunner,
  type UserHookTrigger,
  type ValidationFinding,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookName,
  type WorkflowPreToolUseStage,
  type WorkflowHookResult,
  type WorkflowHookRewritePatch,
} from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type {
  CapabilityEventHookConfig,
  CapabilityHookActionConfig,
  CapabilityHooksConfig,
  CapabilityWorkflowHookConfig,
} from "./config.js";
import {
  TracedProcessRunner,
  inferProcessRuntime,
} from "./traced-process-runner.js";

interface CommonHookActionOptions {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  http?: CapabilityHooksConfig["http"];
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  getRun?: () => RunHandle | undefined;
  agentTool?: ToolDefinition;
}

interface AgentHookActionState {
  active: Set<string>;
  blockedStopActions: Set<string>;
}

type HooksHttpConfig = NonNullable<CapabilityHooksConfig["http"]>;
type HooksHttpAllowRule = NonNullable<HooksHttpConfig["allow"]>[number];

export interface CreateConfiguredWorkflowHooksOptions extends CommonHookActionOptions {
  hooks?: CapabilityWorkflowHookConfig[];
  workflowActive?: boolean;
}

export function createConfiguredWorkflowHooks(
  options: CreateConfiguredWorkflowHooksOptions,
): WorkflowHook[] {
  const agentHookState: AgentHookActionState = {
    active: new Set(),
    blockedStopActions: new Set(),
  };
  return (options.hooks ?? [])
    .filter((config) => config.enabled !== false)
    .map((config) => {
      const seenTurns = new Set<string>();
      return {
        name: config.name,
        description: config.description,
        hook: config.hook,
        ...(config.hook === "PreToolUse"
          ? { preToolUseStage: configuredPreToolUseStage(config.action) }
          : {}),
        matcher: config.matcher,
        onError: config.onError,
        handle: (input) => {
          if (config.frequency === "oncePerTurn") {
            const turnKey = `${input.run.id}:${input.step ?? "no-step"}`;
            if (seenTurns.has(turnKey)) {
              return {
                status: "skipped" as const,
                reason: "configured hook already ran for this turn",
              };
            }
            seenTurns.add(turnKey);
          }
          return runConfiguredHookAction(config.action, input, {
            ...hookActionRuntimeOptions(options),
            hookName: config.name,
            agentHookState,
            workflowActive: options.workflowActive === true,
          });
        },
      };
    });
}

export interface BindConfiguredEventHooksOptions extends CommonHookActionOptions {
  hooks?: CapabilityEventHookConfig[];
  run: RunHandle;
}

export function bindConfiguredEventHooks(
  options: BindConfiguredEventHooksOptions,
): () => void {
  const unsubscribes = (options.hooks ?? [])
    .filter((config) => config.enabled !== false)
    .map((config) => bindConfiguredEventHook(config, options));
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

function bindConfiguredEventHook(
  config: CapabilityEventHookConfig,
  options: BindConfiguredEventHooksOptions,
): () => void {
  const runner = createEventHookRunner(config, options, {
    active: new Set(),
    blockedStopActions: new Set(),
  });
  return bindUserHooks({
    events: options.run.events,
    runner,
    signal: options.run.abortSignal,
    resolveDescriptor: (trigger) => ({
      hookId: `event:${config.name}:${trigger}`,
      hookName: config.name,
      source: "project",
      metadata: {
        source: "events",
        trigger,
        actionType: config.action.type,
      },
    }),
  });
}

function createEventHookRunner(
  config: CapabilityEventHookConfig,
  options: BindConfiguredEventHooksOptions,
  agentHookState: AgentHookActionState,
): UserHookRunner {
  return {
    triggers: () => eventHookTriggers(config.trigger),
    async invoke(invocation): Promise<UserHookOutcome> {
      if (!matchesEventHook(config, invocation.event)) {
        return {
          status: "skipped",
          reason: "event hook matcher did not match",
        };
      }
      return runEventHookAction(
        config.action,
        invocation,
        config.name,
        options,
        agentHookState,
      );
    },
  };
}

interface RunConfiguredHookActionOptions {
  hookName: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sandboxConfig: ResolvedShellSandboxConfig;
  sandboxRuntime: ShellSandboxRuntime;
  processKind?: ProcessInvocationBase["kind"];
  getRun?: () => RunHandle | undefined;
  agentTool?: ToolDefinition;
  http?: CapabilityHooksConfig["http"];
  agentHookState?: AgentHookActionState;
  workflowActive?: boolean;
}

interface HookActionInput<TPayload = unknown> {
  hook?: WorkflowHookName;
  run: WorkflowHookInput["run"];
  step?: number;
  payload: TPayload;
  metadata: Record<string, unknown>;
  events?: WorkflowHookInput["events"];
}

async function runConfiguredHookAction(
  action: CapabilityHookActionConfig,
  input: WorkflowHookInput,
  options: RunConfiguredHookActionOptions,
): Promise<WorkflowHookResult> {
  const label = `Workflow hook "${options.hookName}"`;
  let result: WorkflowHookResult;
  if (action.type === "block") {
    result = { status: "block", reason: action.reason };
  } else if (action.type === "context") {
    result = {
      status: "continue",
      context: [
        createHookContextItem({
          hookName: options.hookName,
          hook: input.hook,
          content: action.content,
          type: action.contextType ?? "summary",
        }),
      ],
    };
  } else if (action.type === "command") {
    result = await runCommandWorkflowAction(action, input, options);
  } else if (action.type === "http") {
    result = await runHttpWorkflowAction(action, input, options);
  } else if (action.type === "agent") {
    result = await runAgentWorkflowAction(action, input, options);
  } else {
    const exhaustive: never = action;
    void exhaustive;
    throw new Error("Unsupported workflow hook action type.");
  }
  return enforceWorkflowHookEffect(input.hook, result, label, {
    workflowActive: options.workflowActive === true,
  });
}

async function runCommandWorkflowAction(
  action: Extract<CapabilityHookActionConfig, { type: "command" }>,
  input: HookActionInput,
  options: RunConfiguredHookActionOptions,
): Promise<WorkflowHookResult> {
  const result = await runCommandAction(action, input, options);
  const metadata = commandResultMetadata(
    options.hookName,
    input,
    action,
    result,
  );
  const failed = result.timedOut || result.exitCode !== 0;
  if (action.blockOnFailure === true && failed) {
    return {
      status: "block",
      reason: `Command hook "${options.hookName}" failed with exit code ${result.exitCode}.`,
      metadata,
    };
  }
  if (action.resultMode === "stdoutJson" && !failed) {
    return parseTextWorkflowHookResult(
      result.stdout,
      "Command hook resultMode=stdoutJson",
      metadata,
    );
  }
  return continueWithOptionalContext({
    hookName: options.hookName,
    hook: input.hook,
    metadata,
    injectOutput: action.injectOutput,
    failed,
  });
}

async function runHttpWorkflowAction(
  action: Extract<CapabilityHookActionConfig, { type: "http" }>,
  input: HookActionInput,
  options: RunConfiguredHookActionOptions,
): Promise<WorkflowHookResult> {
  const result = await runHttpAction(action, input, options.http);
  const metadata = httpResultMetadata(options.hookName, input, action, result);
  const failed = !result.ok || result.timedOut;
  if (action.blockOnFailure === true && failed) {
    return {
      status: "block",
      reason: `HTTP hook "${options.hookName}" failed with status ${result.status ?? "network_error"}.`,
      metadata,
    };
  }
  if (action.resultMode === "responseJson" && !failed) {
    return parseTextWorkflowHookResult(
      result.body,
      "HTTP hook resultMode=responseJson",
      metadata,
    );
  }
  return continueWithOptionalContext({
    hookName: options.hookName,
    hook: input.hook,
    metadata,
    injectOutput: action.injectOutput,
    failed,
  });
}

async function runAgentWorkflowAction(
  action: Extract<CapabilityHookActionConfig, { type: "agent" }>,
  input: HookActionInput,
  options: RunConfiguredHookActionOptions,
): Promise<WorkflowHookResult> {
  const identity = agentActionIdentity(options.hookName, input.hook, action);
  const stopBlockKey =
    input.hook === "Stop" ? `${input.run.id}:${identity}` : undefined;
  if (
    stopBlockKey &&
    options.agentHookState?.blockedStopActions.has(stopBlockKey)
  ) {
    return {
      status: "skipped",
      reason:
        "agent hook action already blocked this Stop lifecycle for the run",
      metadata: {
        hookName: options.hookName,
        hook: input.hook,
        actionType: "agent",
        repeatedBlockSignature: true,
      },
    };
  }
  const output = await runAgentAction(action, options, identity);
  const metadata = agentResultMetadata(options.hookName, input, action, output);
  let result: WorkflowHookResult;
  if (action.resultMode === "workflowResult") {
    result = parseUnknownWorkflowHookResult(
      output,
      "Agent hook resultMode=workflowResult",
      metadata,
    );
  } else {
    result = continueWithOptionalContext({
      hookName: options.hookName,
      hook: input.hook,
      metadata,
      injectOutput: action.injectOutput,
      failed: false,
    });
  }
  if (stopBlockKey && result.status === "block") {
    options.agentHookState?.blockedStopActions.add(stopBlockKey);
  }
  return result;
}

async function runEventHookAction(
  action: CapabilityEventHookConfig["action"],
  invocation: Parameters<UserHookRunner["invoke"]>[0],
  hookName: string,
  options: BindConfiguredEventHooksOptions,
  agentHookState: AgentHookActionState,
): Promise<UserHookOutcome> {
  const started = Date.now();
  const runtimeOptions = {
    ...hookActionRuntimeOptions(options),
    hookName,
    processKind: "user_hook" as const,
    agentHookState,
  };
  const input: HookActionInput = {
    run: options.run.record,
    payload: invocation.event.payload,
    metadata: {
      eventType: invocation.event.type,
      eventId: invocation.event.id,
      sequence: invocation.event.sequence,
      trigger: invocation.trigger,
    },
    events: options.run.events,
  };
  try {
    if (action.type === "command") {
      const result = await runCommandAction(action, input, runtimeOptions);
      const output = JSON.stringify({
        command: commandResultMetadata(hookName, input, action, result),
      });
      if (result.timedOut || result.exitCode !== 0) {
        return {
          status: "failed",
          durationMs: Date.now() - started,
          error: {
            code: result.timedOut
              ? "EVENT_COMMAND_TIMED_OUT"
              : "EVENT_COMMAND_FAILED",
            message: `Event hook "${hookName}" failed with exit code ${result.exitCode}.`,
          },
          output,
        };
      }
      return { status: "ok", durationMs: Date.now() - started, output };
    }
    if (action.type === "http") {
      const result = await runHttpAction(action, input, runtimeOptions.http);
      const output = JSON.stringify({
        http: httpResultMetadata(hookName, input, action, result),
      });
      if (result.timedOut || !result.ok) {
        return {
          status: "failed",
          durationMs: Date.now() - started,
          error: {
            code: result.timedOut
              ? "EVENT_HTTP_TIMED_OUT"
              : "EVENT_HTTP_FAILED",
            message: `Event hook "${hookName}" failed with status ${result.status ?? "network_error"}.`,
          },
          output,
        };
      }
      return { status: "ok", durationMs: Date.now() - started, output };
    }
    if (action.type === "agent") {
      const output = await runAgentAction(
        action,
        runtimeOptions,
        agentActionIdentity(hookName, undefined, action),
      );
      return {
        status: "ok",
        durationMs: Date.now() - started,
        output: JSON.stringify({
          agent: agentResultMetadata(hookName, input, action, output),
        }),
      };
    }
    const exhaustive: never = action;
    void exhaustive;
    throw new Error("Unsupported event hook action type.");
  } catch (cause) {
    return {
      status: "failed",
      durationMs: Date.now() - started,
      error: {
        code: "EVENT_HOOK_ACTION_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

function continueWithOptionalContext(input: {
  hookName: string;
  hook?: WorkflowHookName;
  metadata: Record<string, unknown>;
  injectOutput?: "always" | "onFailure" | "never";
  failed: boolean;
}): WorkflowHookResult {
  const injectOutput =
    input.injectOutput ?? defaultInjectOutputPolicy(input.hook);
  if (!shouldInjectOutput(injectOutput, input.failed)) {
    return { status: "continue", metadata: input.metadata };
  }
  if (!input.hook) {
    throw new Error("Workflow hook context injection requires a hook name.");
  }
  if (!workflowHookAllowsContext(input.hook)) {
    throw new Error(
      `Workflow hook "${input.hook}" does not support context injection; set injectOutput to "never" or use a context-capable lifecycle.`,
    );
  }
  return {
    status: "continue",
    context: [
      createHookContextItem({
        hookName: input.hookName,
        hook: input.hook,
        content: JSON.stringify(input.metadata),
        type: "summary",
      }),
    ],
    metadata: input.metadata,
  };
}

function shouldInjectOutput(
  policy: "always" | "onFailure" | "never",
  failed: boolean,
): boolean {
  if (policy === "never") return false;
  if (policy === "onFailure") return failed;
  return true;
}

function defaultInjectOutputPolicy(
  hook: WorkflowHookName | undefined,
): "always" | "never" {
  return hook && workflowHookAllowsContext(hook) ? "always" : "never";
}

function enforceWorkflowHookEffect(
  hook: WorkflowHookName,
  result: WorkflowHookResult,
  label: string,
  options: { workflowActive?: boolean } = {},
): WorkflowHookResult {
  if (options.workflowActive === true && result.status === "advance") {
    throw new Error(
      `${label} returned advance while a workflow is active; configured hooks cannot advance workflow-controlled runs.`,
    );
  }
  if (result.status === "block" && !workflowHookAllowsBlock(hook)) {
    throw new Error(
      `${label} returned block for ${hook}, but this lifecycle cannot block run execution.`,
    );
  }
  if (result.status === "rewrite" && !workflowHookAllowsRewrite(hook)) {
    throw new Error(
      `${label} returned rewrite for ${hook}, but rewrite is only supported for PreToolUse.`,
    );
  }
  if (result.status === "advance" && !workflowHookAllowsAdvance(hook)) {
    throw new Error(
      `${label} returned advance for ${hook}, but advance is only supported for ModelOutput and Stop.`,
    );
  }
  if (
    result.status === "continue" &&
    result.context !== undefined &&
    result.context.length > 0 &&
    !workflowHookAllowsContext(hook)
  ) {
    throw new Error(
      `${label} returned context for ${hook}, but this lifecycle does not consume context.`,
    );
  }
  return result;
}

function configuredPreToolUseStage(
  action: CapabilityHookActionConfig,
): WorkflowPreToolUseStage {
  if (action.type === "command" && action.resultMode === "stdoutJson") {
    return "rewrite";
  }
  if (action.type === "http" && action.resultMode === "responseJson") {
    return "rewrite";
  }
  if (action.type === "agent" && action.resultMode === "workflowResult") {
    return "rewrite";
  }
  return "governance";
}

function workflowHookAllowsBlock(hook: WorkflowHookName): boolean {
  return hook !== "RunEnd";
}

function workflowHookAllowsRewrite(hook: WorkflowHookName): boolean {
  return hook === "PreToolUse";
}

function workflowHookAllowsAdvance(hook: WorkflowHookName): boolean {
  return hook === "ModelOutput" || hook === "Stop";
}

function workflowHookAllowsContext(hook: WorkflowHookName): boolean {
  return (
    hook === "RunStart" ||
    hook === "TurnStart" ||
    hook === "ModelOutput" ||
    hook === "PostToolUse" ||
    hook === "RuntimeSignal"
  );
}

function parseTextWorkflowHookResult(
  text: string,
  label: string,
  actionMetadata: Record<string, unknown>,
): WorkflowHookResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} produced no body.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} produced invalid JSON: ${detail}`);
  }
  return parseUnknownWorkflowHookResult(parsed, label, actionMetadata);
}

function parseUnknownWorkflowHookResult(
  value: unknown,
  label: string,
  actionMetadata: Record<string, unknown>,
): WorkflowHookResult {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} produced invalid JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must produce a JSON object.`);
  }
  const status = parsed.status === undefined ? "continue" : parsed.status;
  if (
    status !== "continue" &&
    status !== "block" &&
    status !== "advance" &&
    status !== "rewrite" &&
    status !== "skipped"
  ) {
    throw new Error(
      `${label} status must be continue, block, advance, rewrite, or skipped.`,
    );
  }
  const metadata = mergeActionResultMetadata(parsed.metadata, actionMetadata);
  if (status === "block") {
    if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
      throw new Error(`${label} block result requires reason.`);
    }
    return {
      status: "block",
      reason: parsed.reason,
      ...(Array.isArray(parsed.findings)
        ? { findings: parsed.findings as ValidationFinding[] }
        : {}),
      metadata,
    };
  }
  if (status === "advance") {
    if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
      throw new Error(`${label} advance result requires reason.`);
    }
    return {
      status: "advance",
      reason: parsed.reason,
      metadata,
    };
  }
  if (status === "rewrite") {
    if (!isRecord(parsed.patch)) {
      throw new Error(`${label} rewrite result requires patch object.`);
    }
    return {
      status: "rewrite",
      patch: parsed.patch as WorkflowHookRewritePatch,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      metadata,
    };
  }
  if (status === "skipped") {
    return {
      status: "skipped",
      reason:
        typeof parsed.reason === "string" && parsed.reason.length > 0
          ? parsed.reason
          : `${label} skipped`,
      metadata,
    };
  }
  return { status: "continue", metadata };
}

function mergeActionResultMetadata(
  metadata: unknown,
  actionMetadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(isRecord(metadata) ? metadata : {}),
    actionResult: actionMetadata,
  };
}

function createHookContextItem(input: {
  hookName: string;
  hook: string;
  content: string;
  type: Extract<ContextItem["type"], "system" | "user" | "summary">;
}): ContextItem {
  return {
    id: createContextItemId(),
    type: input.type,
    source: { kind: "extension", uri: `workflow-hook:${input.hookName}` },
    content: input.content,
    metadata: {
      layer: "working",
      stability: "turn",
      workflowHook: input.hook,
      hookName: input.hookName,
      configured: true,
    },
  };
}

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: ProcessOutputSummary;
  sandbox?: SandboxSummary;
  progressCount: number;
  progressDropped: number;
}

async function runCommandAction(
  action: Extract<CapabilityHookActionConfig, { type: "command" }>,
  input: HookActionInput,
  options: RunConfiguredHookActionOptions,
): Promise<CommandResult> {
  const cwd = action.cwd
    ? isAbsolute(action.cwd)
      ? action.cwd
      : resolve(options.workspaceRoot, action.cwd)
    : options.workspaceRoot;
  const maxOutputBytes = action.maxOutputBytes ?? 32_000;
  const stdin =
    action.stdin === "json"
      ? `${JSON.stringify(hookActionStdin(input))}\n`
      : undefined;
  const runner = new TracedProcessRunner();
  const result = await runner.run({
    emitter: input.events ?? createBufferedEmitter(),
    runId: input.run.id,
    name: options.hookName,
    kind: options.processKind ?? "workflow_hook",
    runtime: inferProcessRuntime(action.command),
    command: action.command,
    args: action.args ?? [],
    cwd,
    env: options.env,
    stdin,
    timeoutMs: action.timeoutMs,
    sandbox: options.sandboxConfig,
    sandboxRuntime: options.sandboxRuntime,
    outputLimits: {
      previewBytes: maxOutputBytes,
      artifactBytes: action.maxOutputBytes ?? 32_000,
      maxStdoutBytes: action.maxOutputBytes ?? 32_000,
      maxStderrBytes: action.maxOutputBytes ?? 32_000,
    },
  });
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.output.stdoutPreview ?? "",
    stderr: result.output.stderrPreview ?? "",
    output: result.output,
    sandbox: result.sandbox,
    progressCount: result.progressCount,
    progressDropped: result.progressDropped,
  };
}

interface HttpResult {
  ok: boolean;
  status: number | null;
  statusText: string;
  body: string;
  timedOut: boolean;
}

async function runHttpAction(
  action: Extract<CapabilityHookActionConfig, { type: "http" }>,
  input: HookActionInput,
  httpConfig: CapabilityHooksConfig["http"] | undefined,
): Promise<HttpResult> {
  const safeAddresses = await assertHttpHookAllowed(action.url, httpConfig);
  const url = parseHttpHookUrl(action.url);
  const method = action.method ?? "POST";
  const body =
    action.body ??
    (method === "GET" || method === "DELETE"
      ? undefined
      : JSON.stringify(httpHookActionBody(input)));
  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  if (body !== undefined && !hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json";
  }
  // Pin the connection to the addresses validated by assertHttpHookAllowed and
  // do not follow redirects. Global fetch re-resolves DNS independently and
  // transparently follows 3xx, both of which let an allowlisted host pivot to a
  // blocked address (DNS rebind, or a redirect to 169.254.169.254) after the
  // pre-flight check passed. node:http(s) with a fixed lookup closes that
  // window; Host and TLS SNI still use the original hostname.
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup = ((
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all) {
      callback(
        null,
        safeAddresses.map((address) => ({
          address,
          family: isIP(address) || 4,
        })),
      );
      return;
    }
    const address = safeAddresses[0]!;
    callback(null, address, isIP(address) || 4);
  }) as unknown as LookupFunction;
  return await new Promise<HttpResult>((resolveResult) => {
    let settled = false;
    let timedOut = false;
    const settle = (result: HttpResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const req = requestFn(
      url,
      { method, headers, lookup, timeout: action.timeoutMs },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? null;
          settle({
            ok: status !== null && status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? "",
            body: data,
            timedOut: false,
          });
        });
      },
    );
    if (action.timeoutMs) {
      req.setTimeout(action.timeoutMs, () => {
        timedOut = true;
        req.destroy(new Error("timed out"));
      });
    }
    req.on("error", (cause: Error) => {
      settle({
        ok: false,
        status: null,
        statusText: timedOut ? "timed out" : cause.message,
        body: "",
        timedOut,
      });
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function assertHttpHookAllowed(
  rawUrl: string,
  config: CapabilityHooksConfig["http"] | undefined,
): Promise<string[]> {
  if (config?.enabled !== true) {
    throw new Error(
      "HTTP hook actions are disabled; enable capabilities.hooks.http.enabled and configure capabilities.hooks.http.allow in user config or SPARKWRIGHT_CONFIG.",
    );
  }
  if (!config.allow || config.allow.length === 0) {
    throw new Error(
      "HTTP hook actions require at least one capabilities.hooks.http.allow rule.",
    );
  }
  const url = parseHttpHookUrl(rawUrl);
  if (!httpUrlMatchesAllowlist(url, config.allow)) {
    throw new Error(
      `HTTP hook URL ${url.origin} is not allowed by capabilities.hooks.http.allow.`,
    );
  }
  const addresses = await resolveHttpHookAddresses(url.hostname);
  for (const address of addresses) {
    const classification = classifyIpAddress(address);
    if (classification.alwaysBlocked) {
      throw new Error(
        `HTTP hook URL resolves to blocked link-local address ${address}.`,
      );
    }
    if (classification.privateNetwork && config.allowPrivateNetwork !== true) {
      throw new Error(
        `HTTP hook URL resolves to private address ${address}; set capabilities.hooks.http.allowPrivateNetwork only in trusted user config if this is intentional.`,
      );
    }
  }
  return addresses;
}

function parseHttpHookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("HTTP hook URL must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP hook URL must use http or https.");
  }
  return url;
}

function httpUrlMatchesAllowlist(
  url: URL,
  rules: readonly HooksHttpAllowRule[],
): boolean {
  const hostname = normalizeHostname(url.hostname);
  return rules.some((rule) => {
    if ("origin" in rule) {
      return parseHttpHookUrl(rule.origin).origin === url.origin;
    }
    return normalizeHostname(rule.hostname) === hostname;
  });
}

async function resolveHttpHookAddresses(hostname: string): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized) !== 0) return [normalized];
  try {
    const results = await lookup(normalized, { all: true });
    return results.map((result) => result.address);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `HTTP hook hostname ${normalized} could not be resolved: ${detail}`,
    );
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function classifyIpAddress(address: string): {
  privateNetwork: boolean;
  alwaysBlocked: boolean;
} {
  const version = isIP(address);
  if (version === 4) return classifyIpv4Address(address);
  if (version === 6) return classifyIpv6Address(address);
  return { privateNetwork: false, alwaysBlocked: false };
}

function classifyIpv4Address(address: string): {
  privateNetwork: boolean;
  alwaysBlocked: boolean;
} {
  const parts = address.split(".").map((part) => Number(part));
  const [a = 0, b = 0] = parts;
  const linkLocal = a === 169 && b === 254;
  const privateNetwork =
    linkLocal ||
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
  return { privateNetwork, alwaysBlocked: linkLocal };
}

function classifyIpv6Address(address: string): {
  privateNetwork: boolean;
  alwaysBlocked: boolean;
} {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIpv4Address(mapped[1]!);
  const firstHextet = Number.parseInt(normalized.split(":")[0] ?? "0", 16);
  const linkLocal = (firstHextet & 0xffc0) === 0xfe80;
  const uniqueLocal = (firstHextet & 0xfe00) === 0xfc00;
  const loopback = normalized === "::1";
  return {
    privateNetwork: linkLocal || uniqueLocal || loopback,
    alwaysBlocked: linkLocal,
  };
}

function agentActionIdentity(
  hookName: string,
  hook: WorkflowHookName | undefined,
  action: Extract<CapabilityHookActionConfig, { type: "agent" }>,
): string {
  return JSON.stringify({
    hookName,
    hook,
    agentId: action.agentId,
    toolName: action.toolName,
    goal: action.goal,
  });
}

async function runAgentAction(
  action: Extract<CapabilityHookActionConfig, { type: "agent" }>,
  options: RunConfiguredHookActionOptions,
  identity: string,
): Promise<unknown> {
  const parent = options.getRun?.();
  if (!parent || !options.agentTool) {
    throw new Error(
      "Agent hook actions require a host runtime with configured delegate agents.",
    );
  }
  const args = {
    ...(action.agentId ? { agentId: action.agentId } : {}),
    ...(action.toolName ? { toolName: action.toolName } : {}),
    goal: action.goal,
    metadata: {
      ...(action.metadata ?? {}),
      sparkwrightHookAction: {
        hookName: options.hookName,
      },
    },
  };
  const policy =
    options.agentTool.policyForArgs?.(args)?.policy ?? options.agentTool.policy;
  if (policy?.requiresApproval === true || policy?.risk === "risky") {
    throw new Error(
      "Agent hook action target requires approval; hooks cannot prompt for delegate spawn approval.",
    );
  }
  if (options.agentHookState?.active.has(identity)) {
    throw new Error(
      `Agent hook action "${options.hookName}" is already running; refusing recursive hook spawn.`,
    );
  }
  const ctx: RuntimeContext = {
    run: parent.record,
    workspace: parent.getWorkspace?.(),
    abortSignal: parent.abortSignal,
  };
  options.agentHookState?.active.add(identity);
  try {
    return await options.agentTool.execute(args, ctx);
  } finally {
    options.agentHookState?.active.delete(identity);
  }
}

function commandResultMetadata(
  hookName: string,
  input: HookActionInput,
  action: Extract<CapabilityHookActionConfig, { type: "command" }>,
  result: CommandResult,
): Record<string, unknown> {
  return {
    hookName,
    ...(input.hook ? { hook: input.hook } : {}),
    ...input.metadata,
    command: action.command,
    args: action.args ?? [],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    sandbox: result.sandbox,
    progressCount: result.progressCount,
    progressDropped: result.progressDropped,
  };
}

function httpResultMetadata(
  hookName: string,
  input: HookActionInput,
  action: Extract<CapabilityHookActionConfig, { type: "http" }>,
  result: HttpResult,
): Record<string, unknown> {
  return {
    hookName,
    ...(input.hook ? { hook: input.hook } : {}),
    ...input.metadata,
    url: action.url,
    method: action.method ?? "POST",
    status: result.status,
    statusText: result.statusText,
    ok: result.ok,
    timedOut: result.timedOut,
    body: result.body,
  };
}

function agentResultMetadata(
  hookName: string,
  input: HookActionInput,
  action: Extract<CapabilityHookActionConfig, { type: "agent" }>,
  output: unknown,
): Record<string, unknown> {
  return {
    hookName,
    ...(input.hook ? { hook: input.hook } : {}),
    ...input.metadata,
    ...(action.agentId ? { agentId: action.agentId } : {}),
    ...(action.toolName ? { toolName: action.toolName } : {}),
    goal: action.goal,
    output,
  };
}

function hookActionStdin(input: HookActionInput): Record<string, unknown> {
  return {
    ...(input.hook ? { hook: input.hook } : {}),
    run: input.run,
    step: input.step,
    payload: input.payload,
    metadata: input.metadata,
  };
}

function httpHookActionBody(input: HookActionInput): Record<string, unknown> {
  const runExtras =
    isRecord(input.run) && typeof input.run.stopReason === "string"
      ? { stopReason: input.run.stopReason }
      : {};
  return {
    ...(input.hook ? { hook: input.hook } : {}),
    run: {
      id: input.run.id,
      state: input.run.state,
      ...runExtras,
    },
    step: input.step,
    metadata: input.metadata,
  };
}

function hookActionRuntimeOptions(
  options: CommonHookActionOptions,
): Omit<RunConfiguredHookActionOptions, "hookName"> {
  return {
    workspaceRoot: options.workspaceRoot,
    env: options.env ?? process.env,
    sandboxConfig:
      options.sandbox && "forcedDenyWrite" in options.sandbox
        ? options.sandbox
        : resolveShellSandboxConfig({
            workspaceRoot: options.workspaceRoot,
            config: options.sandbox,
            skillRoots: options.skillRoots,
            extraForcedDenyWrite: options.configPaths,
          }),
    sandboxRuntime:
      options.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
    http: options.http,
    getRun: options.getRun,
    agentTool: options.agentTool,
  };
}

function eventHookTriggers(
  trigger: CapabilityEventHookConfig["trigger"],
): UserHookTrigger[] {
  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  return triggers.filter(isUserHookTrigger);
}

function matchesEventHook(
  config: CapabilityEventHookConfig,
  event: SparkwrightEvent,
): boolean {
  const matcher = config.matcher;
  if (!matcher) return true;
  const payload = isRecord(event.payload) ? event.payload : {};
  if (!matchesValue(matcher.eventType, event.type)) return false;
  if (!matchesValue(matcher.toolName, stringValue(payload.toolName))) {
    return false;
  }
  if (!matchesValue(matcher.status, eventStatus(event.type))) return false;
  const path =
    stringValue(payload.path) ??
    stringValue(payload.workspacePath) ??
    stringValue(payload.file);
  if (matcher.pathGlob !== undefined) {
    if (!path || !matchesAnyGlob(matcher.pathGlob, path)) return false;
  }
  if (
    matcher.excludePathGlob !== undefined &&
    path &&
    matchesAnyGlob(matcher.excludePathGlob, path)
  ) {
    return false;
  }
  return true;
}

function eventStatus(type: string): string | undefined {
  if (type.endsWith(".completed")) return "completed";
  if (type.endsWith(".failed")) return "failed";
  if (type.endsWith(".requested")) return "requested";
  if (type.endsWith(".cancelled")) return "cancelled";
  return undefined;
}

function matchesValue(
  expected: string | readonly string[] | undefined,
  actual: string | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  const values = Array.isArray(expected) ? expected : [expected];
  return values.includes(actual);
}

function matchesAnyGlob(
  patterns: string | readonly string[],
  value: string,
): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((header) => header.toLowerCase() === lower);
}

function isUserHookTrigger(value: string): value is UserHookTrigger {
  return (
    value === "run.started" ||
    value === "run.completed" ||
    value === "run.failed" ||
    value === "run.cancelled" ||
    value === "run.budget.checked" ||
    value === "run.budget.exceeded" ||
    value === "model.requested" ||
    value === "model.completed" ||
    value === "tool.requested" ||
    value === "tool.completed" ||
    value === "tool.failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
