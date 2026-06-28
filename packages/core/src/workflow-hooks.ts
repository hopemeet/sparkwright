// =============================================================================
// AI maintenance note
//
// WorkflowHook is the deterministic, user-facing hook layer over the agent
// lifecycle. Keep the public lifecycle vocabulary small; add matcher fields and
// payload metadata before adding new hook names. Legacy RunHook and
// ValidationHook remain supported for embedders that need lower-level seams.
// =============================================================================

import type { EventEmitter, EventLog } from "./events.js";
import type { ContextItem, RunRecord } from "./types.js";
import type { ValidationFinding } from "./validation.js";

export type WorkflowHookName =
  | "RunStart"
  | "TurnStart"
  | "ModelOutput"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "RunEnd"
  | "RuntimeSignal";

export type WorkflowRuntimeSignal =
  | "budget.checked"
  | "budget.exceeded"
  | "repeated_tool_call"
  | "doom_loop"
  | "run.failed"
  | "run.completed"
  | "run.cancelled";

export type WorkflowHookMatchValue = string | readonly string[];

export interface WorkflowHookMatcher {
  toolName?: WorkflowHookMatchValue;
  eventType?: WorkflowHookMatchValue;
  signal?: WorkflowHookMatchValue;
  status?: WorkflowHookMatchValue;
  pathGlob?: WorkflowHookMatchValue;
  excludePathGlob?: WorkflowHookMatchValue;
}

export interface WorkflowHookInput<TPayload = unknown> {
  hook: WorkflowHookName;
  run: RunRecord;
  step?: number;
  payload: TPayload;
  metadata: Record<string, unknown>;
  events?: EventEmitter;
}

export type WorkflowHookResult =
  | {
      status?: "continue";
      context?: ContextItem[];
      metadata?: Record<string, unknown>;
    }
  | {
      status: "block";
      reason: string;
      findings?: ValidationFinding[];
      metadata?: Record<string, unknown>;
    }
  | {
      status: "rewrite";
      patch: WorkflowHookRewritePatch;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "skipped";
      reason: string;
      metadata?: Record<string, unknown>;
    };

export interface WorkflowHookRewritePatch {
  arguments?: unknown;
  metadata?: Record<string, unknown>;
}

export interface WorkflowHook<TPayload = unknown> {
  name: string;
  description?: string;
  id?: string;
  hook: WorkflowHookName;
  matcher?: WorkflowHookMatcher;
  /**
   * Default is "continue" to match legacy RunHook fault isolation. Use
   * "block" for governance hooks that should fail closed when their own check
   * cannot complete.
   */
  onError?: "continue" | "block";
  handle(
    input: WorkflowHookInput<TPayload>,
  ): WorkflowHookResult | void | Promise<WorkflowHookResult | void>;
}

export interface RunWorkflowHooksInput<TPayload = unknown> {
  hooks: readonly WorkflowHook[];
  hook: WorkflowHookName;
  run: RunRecord;
  step?: number;
  payload: TPayload;
  metadata?: Record<string, unknown>;
  events: EventLog;
}

export interface WorkflowHookBlock {
  hookName: string;
  hookId?: string;
  reason: string;
  findings?: ValidationFinding[];
  metadata?: Record<string, unknown>;
}

export type WorkflowHookExecution =
  | {
      status: "continued";
      context: ContextItem[];
      rewrites: WorkflowHookRewritePatch[];
    }
  | {
      status: "blocked";
      context: ContextItem[];
      rewrites: WorkflowHookRewritePatch[];
      block: WorkflowHookBlock;
    };

export async function runWorkflowHooks(
  input: RunWorkflowHooksInput,
): Promise<WorkflowHookExecution> {
  const context: ContextItem[] = [];
  const rewrites: WorkflowHookRewritePatch[] = [];
  const metadata = input.metadata ?? {};

  for (const hook of input.hooks) {
    if (hook.hook !== input.hook) continue;
    if (!matchesWorkflowHook(hook.matcher, input.payload, metadata)) continue;

    const basePayload = {
      hookName: hook.name,
      description: hook.description,
      hookId: hook.id,
      hook: input.hook,
      step: input.step,
      metadata,
    };
    input.events.emit("workflow_hook.started", basePayload);

    try {
      const result = normalizeWorkflowHookResult(
        await hook.handle({
          hook: input.hook,
          run: input.run,
          step: input.step,
          payload: input.payload,
          metadata,
          events: input.events,
        }),
      );

      if (result.status === "block") {
        const block: WorkflowHookBlock = {
          hookName: hook.name,
          hookId: hook.id,
          reason: result.reason,
          findings: result.findings,
          metadata: result.metadata,
        };
        input.events.emit("workflow_hook.blocked", {
          ...basePayload,
          reason: result.reason,
          findings: result.findings,
          resultMetadata: result.metadata,
        });
        return { status: "blocked", context, rewrites, block };
      }

      if (result.status === "rewrite") {
        rewrites.push(result.patch);
      }
      if (result.status === "continue" && result.context) {
        context.push(...result.context);
      }

      input.events.emit("workflow_hook.completed", {
        ...basePayload,
        result,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      input.events.emit("workflow_hook.failed", {
        ...basePayload,
        error: {
          code: "WORKFLOW_HOOK_THREW",
          message,
        },
      });
      if (hook.onError === "block") {
        const block: WorkflowHookBlock = {
          hookName: hook.name,
          hookId: hook.id,
          reason: message,
          findings: [
            {
              code: "WORKFLOW_HOOK_ERROR",
              message,
              severity: "error",
            },
          ],
        };
        return { status: "blocked", context, rewrites, block };
      }
    }
  }

  return { status: "continued", context, rewrites };
}

function normalizeWorkflowHookResult(
  result: WorkflowHookResult | void,
): WorkflowHookResult & { status: NonNullable<WorkflowHookResult["status"]> } {
  if (!result) return { status: "continue" };
  return {
    status: result.status ?? "continue",
    ...result,
  } as WorkflowHookResult & {
    status: NonNullable<WorkflowHookResult["status"]>;
  };
}

function matchesWorkflowHook(
  matcher: WorkflowHookMatcher | undefined,
  payload: unknown,
  metadata: Record<string, unknown>,
): boolean {
  if (!matcher) return true;
  const record = isRecord(payload) ? payload : {};
  if (!matchesValue(matcher.toolName, stringValue(record.toolName))) {
    return false;
  }
  if (!matchesValue(matcher.eventType, stringValue(record.eventType))) {
    return false;
  }
  if (!matchesValue(matcher.signal, stringValue(record.signal))) {
    return false;
  }
  if (!matchesValue(matcher.status, stringValue(record.status))) {
    return false;
  }
  const path =
    stringValue(record.path) ??
    stringValue(record.workspacePath) ??
    stringValue(metadata.path);
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

function matchesValue(
  expected: WorkflowHookMatchValue | undefined,
  actual: string | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  const values = Array.isArray(expected) ? expected : [expected];
  return values.includes(actual);
}

function matchesAnyGlob(
  patterns: WorkflowHookMatchValue,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
