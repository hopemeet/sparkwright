// =============================================================================
// AI maintenance note
//
// RunHook is the generic lifecycle-middleware seam for the run loop. Use it
// when you need to observe or (narrowly) influence a run without changing the
// loop. Anything more invasive should grow a dedicated extension point.
//
// Wired into packages/core/src/run.ts at:
//   - onEvent           — events.subscribe() in the constructor
//   - beforeModelCall   — completeModelWithRetries(), before model.requested
//   - afterModelCall    — completeModelWithRetries(), after model.completed
//   - beforeToolCall    — processToolCall(), before tool.requested
//   - afterToolCall     — processToolCall(), after tool.completed/failed
//   - onError           — top-level loop catch blocks (best-effort)
//
// Hooks MUST NOT mutate run state directly. The single supported mutation is
// `beforeToolCall` returning `{ skip: { reason } }` to skip a tool call (which
// short-circuits into a synthesized failed ToolResult so the model can react).
//
// See docs/EXTENSION_INTERFACES.md "Run Hooks".
// =============================================================================

import type { ContextItem, ModelOutput, ToolResult } from "./types.js";
import type { PromptMessage } from "./context.js";
import type { SparkwrightEvent } from "./events.js";
import type { RunId } from "./ids.js";

export interface RunHookContext {
  runId: RunId;
  step: number;
}

export interface ToolCallHookInput extends RunHookContext {
  toolName: string;
  arguments: unknown;
}

export interface ToolCallHookDecision {
  /**
   * Skip this tool call. The loop synthesizes a `failed` ToolResult with the
   * supplied reason so the model can observe the skip on the next turn.
   */
  skip?: { reason: string };
}

export interface ToolResultHookInput extends ToolCallHookInput {
  result: ToolResult;
}

export interface ModelCallHookInput extends RunHookContext {
  prompt: PromptMessage[];
  context: ContextItem[];
}

export interface ModelOutputHookInput extends RunHookContext {
  output: ModelOutput;
}

export interface EventHookInput {
  event: SparkwrightEvent;
}

export interface ErrorHookInput extends RunHookContext {
  /**
   * @reserved Public hook-protocol field consumed by RunHook.onError handlers.
   */
  phase: "model" | "tool" | "context" | "validation" | "approval" | "runtime";
  error: unknown;
}

export interface RunHook {
  name: string;
  /**
   * Optional stable identifier. Required only when a hook will be removed
   * via `RunHandle.removeHook(id)` after the run starts. Hooks supplied via
   * `CreateRunOptions.hooks` may omit it. When omitted, `RunHandle.addHook`
   * synthesizes one.
   */
  id?: string;
  beforeToolCall?(
    input: ToolCallHookInput,
  ): void | ToolCallHookDecision | Promise<void | ToolCallHookDecision>;
  afterToolCall?(input: ToolResultHookInput): void | Promise<void>;
  beforeModelCall?(input: ModelCallHookInput): void | Promise<void>;
  afterModelCall?(input: ModelOutputHookInput): void | Promise<void>;
  /**
   * Synchronous event observer. Called for every event emitted by the run.
   * Errors are caught and logged; they do not block the run.
   */
  onEvent?(input: EventHookInput): void;
  onError?(input: ErrorHookInput): void | Promise<void>;
}

/**
 * Compose multiple hooks into one. Hooks run sequentially in the order
 * provided. For `beforeToolCall`, the first hook that returns a `skip`
 * decision wins; subsequent hooks for that call are skipped.
 */
export function combineRunHooks(hooks: readonly RunHook[]): RunHook {
  return {
    name: "combined",
    async beforeToolCall(input) {
      for (const hook of hooks) {
        if (!hook.beforeToolCall) continue;
        try {
          const decision = await hook.beforeToolCall(input);
          if (decision?.skip) return decision;
        } catch (err) {
          logHookError(hook.name, "beforeToolCall", err);
        }
      }
      return undefined;
    },
    async afterToolCall(input) {
      for (const hook of hooks) {
        if (!hook.afterToolCall) continue;
        try {
          await hook.afterToolCall(input);
        } catch (err) {
          logHookError(hook.name, "afterToolCall", err);
        }
      }
    },
    async beforeModelCall(input) {
      for (const hook of hooks) {
        if (!hook.beforeModelCall) continue;
        try {
          await hook.beforeModelCall(input);
        } catch (err) {
          logHookError(hook.name, "beforeModelCall", err);
        }
      }
    },
    async afterModelCall(input) {
      for (const hook of hooks) {
        if (!hook.afterModelCall) continue;
        try {
          await hook.afterModelCall(input);
        } catch (err) {
          logHookError(hook.name, "afterModelCall", err);
        }
      }
    },
    onEvent(input) {
      for (const hook of hooks) {
        if (!hook.onEvent) continue;
        try {
          hook.onEvent(input);
        } catch (err) {
          logHookError(hook.name, "onEvent", err);
        }
      }
    },
    async onError(input) {
      for (const hook of hooks) {
        if (!hook.onError) continue;
        try {
          await hook.onError(input);
        } catch (err) {
          logHookError(hook.name, "onError", err);
        }
      }
    },
  };
}

/**
 * Like {@link combineRunHooks}, but reads the underlying hook list from the
 * provided getter on every phase. Lets the run loop pick up hooks added or
 * removed at runtime via `RunHandle.addHook` / `RunHandle.removeHook` without
 * re-binding the loop's hook reference.
 *
 * Semantics match `combineRunHooks`:
 *   - sequential per phase, in array order
 *   - first `beforeToolCall` that returns `skip` wins
 *   - per-hook errors are caught and logged, never thrown out
 */
export function createDynamicHookSet(
  getHooks: () => readonly RunHook[],
): RunHook {
  return {
    name: "dynamic",
    async beforeToolCall(input) {
      for (const hook of getHooks()) {
        if (!hook.beforeToolCall) continue;
        try {
          const decision = await hook.beforeToolCall(input);
          if (decision?.skip) return decision;
        } catch (err) {
          logHookError(hook.name, "beforeToolCall", err);
        }
      }
      return undefined;
    },
    async afterToolCall(input) {
      for (const hook of getHooks()) {
        if (!hook.afterToolCall) continue;
        try {
          await hook.afterToolCall(input);
        } catch (err) {
          logHookError(hook.name, "afterToolCall", err);
        }
      }
    },
    async beforeModelCall(input) {
      for (const hook of getHooks()) {
        if (!hook.beforeModelCall) continue;
        try {
          await hook.beforeModelCall(input);
        } catch (err) {
          logHookError(hook.name, "beforeModelCall", err);
        }
      }
    },
    async afterModelCall(input) {
      for (const hook of getHooks()) {
        if (!hook.afterModelCall) continue;
        try {
          await hook.afterModelCall(input);
        } catch (err) {
          logHookError(hook.name, "afterModelCall", err);
        }
      }
    },
    onEvent(input) {
      for (const hook of getHooks()) {
        if (!hook.onEvent) continue;
        try {
          hook.onEvent(input);
        } catch (err) {
          logHookError(hook.name, "onEvent", err);
        }
      }
    },
    async onError(input) {
      for (const hook of getHooks()) {
        if (!hook.onError) continue;
        try {
          await hook.onError(input);
        } catch (err) {
          logHookError(hook.name, "onError", err);
        }
      }
    },
  };
}

function logHookError(hookName: string, phase: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[sparkwright] hook "${hookName}" failed during ${phase}: ${message}`,
  );
}
