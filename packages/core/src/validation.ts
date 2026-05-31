// AI maintenance note: ValidationHooks are *stage-scoped* checks
// (tool_result, post_sampling, pre_terminal, final_output) that can block or
// continue a run. Generic lifecycle middleware lives in hooks.ts (RunHook).
// Reach for ValidationHook when you need to assert content rules; reach for
// RunHook when you need to observe/instrument the loop.

import type { EventLog } from "./events.js";
import type { RunRecord } from "./types.js";

export type ValidationStage =
  | "tool_result"
  | "workspace_write"
  | "final_output"
  /**
   * Runs after the model produces a final answer (no tool calls) but BEFORE
   * the run is marked completed. A failed `pre_terminal` hook can block
   * termination — the loop converts it into a continuation context item and
   * proceeds to another turn (stop_hook_blocked). Modeled after stop-hook patterns.
   */
  | "pre_terminal"
  /**
   * Fire-and-forget hook that observes model output. Loop does NOT await,
   * does NOT branch on results. Errors are logged via events. Useful for
   * telemetry, async safety probes, post-hoc graders.
   */
  | "post_sampling";

export type ValidationSeverity = "info" | "warning" | "error";

export interface ValidationFinding {
  code: string;
  message: string;
  severity?: ValidationSeverity;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  status: "passed" | "failed";
  findings?: ValidationFinding[];
  metadata?: Record<string, unknown>;
}

export interface ValidationInput<TSubject = unknown> {
  stage: ValidationStage;
  run: RunRecord;
  subject: TSubject;
  metadata: Record<string, unknown>;
}

export interface ValidationHook<TSubject = unknown> {
  name: string;
  stages?: ValidationStage[];
  validate(
    input: ValidationInput<TSubject>,
  ): Promise<ValidationResult | void> | ValidationResult | void;
}

export interface ValidationFailure {
  hookName: string;
  result: ValidationResult;
}

export interface RunValidationHooksInput {
  hooks: ValidationHook[];
  stage: ValidationStage;
  run: RunRecord;
  subject: unknown;
  metadata?: Record<string, unknown>;
  events: EventLog;
}

export async function runValidationHooks(
  input: RunValidationHooksInput,
): Promise<ValidationFailure | undefined> {
  for (const hook of input.hooks) {
    if (!shouldRunHook(hook, input.stage)) continue;

    const metadata = input.metadata ?? {};
    input.events.emit("validation.started", {
      hookName: hook.name,
      stage: input.stage,
      metadata,
    });

    try {
      const result = normalizeValidationResult(
        await hook.validate({
          stage: input.stage,
          run: input.run,
          subject: input.subject,
          metadata,
        }),
      );

      if (result.status === "failed") {
        input.events.emit("validation.failed", {
          hookName: hook.name,
          stage: input.stage,
          result,
          metadata,
        });
        return {
          hookName: hook.name,
          result,
        };
      }

      input.events.emit("validation.completed", {
        hookName: hook.name,
        stage: input.stage,
        result,
        metadata,
      });
    } catch (cause) {
      const result: ValidationResult = {
        status: "failed",
        findings: [
          {
            code: "VALIDATION_HOOK_ERROR",
            message:
              cause instanceof Error
                ? cause.message
                : "Validation hook failed.",
            severity: "error",
            metadata: { cause },
          },
        ],
      };
      input.events.emit("validation.failed", {
        hookName: hook.name,
        stage: input.stage,
        result,
        metadata,
      });
      return {
        hookName: hook.name,
        result,
      };
    }
  }

  return undefined;
}

/**
 * Run `post_sampling` hooks fire-and-forget. The returned promise resolves
 * after all hooks settle but the loop should NOT await it. Errors are
 * emitted as `validation.failed` events; nothing bubbles back into the loop.
 *
 * @public
 * @stability experimental v0.1
 */
export function kickPostSamplingHooks(input: RunValidationHooksInput): void {
  const hooks = input.hooks.filter((hook) =>
    shouldRunHook(hook, "post_sampling"),
  );
  if (hooks.length === 0) return;

  void Promise.all(
    hooks.map(async (hook) => {
      const metadata = input.metadata ?? {};
      input.events.emit("validation.started", {
        hookName: hook.name,
        stage: "post_sampling",
        metadata,
      });
      try {
        const result = normalizeValidationResult(
          await hook.validate({
            stage: "post_sampling",
            run: input.run,
            subject: input.subject,
            metadata,
          }),
        );
        input.events.emit(
          result.status === "failed"
            ? "validation.failed"
            : "validation.completed",
          { hookName: hook.name, stage: "post_sampling", result, metadata },
        );
      } catch (cause) {
        input.events.emit("validation.failed", {
          hookName: hook.name,
          stage: "post_sampling",
          result: {
            status: "failed",
            findings: [
              {
                code: "POST_SAMPLING_HOOK_ERROR",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Post-sampling hook failed.",
                severity: "warning",
              },
            ],
          },
          metadata,
        });
      }
    }),
  );
}

export function validationFailureMessage(failure: ValidationFailure): string {
  const firstFinding = failure.result.findings?.[0];
  return firstFinding
    ? `${failure.hookName}: ${firstFinding.message}`
    : `${failure.hookName}: validation failed.`;
}

function shouldRunHook(hook: ValidationHook, stage: ValidationStage): boolean {
  return hook.stages === undefined || hook.stages.includes(stage);
}

function normalizeValidationResult(
  result: ValidationResult | void,
): ValidationResult {
  return result ?? { status: "passed" };
}
