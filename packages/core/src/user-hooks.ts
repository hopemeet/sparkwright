// =============================================================================
// AI maintenance note
//
// UserHookRunner is the contract for *user-configurable* hooks — typically
// shell commands declared in a host's settings.json (analogous to Git or
// editor hooks). It is DISTINCT from `RunHook` in hooks.ts:
//
//   RunHook            → developer-supplied, in-process JS middleware. Wired
//                        in code at run construction time.
//   UserHookRunner     → end-user-supplied side-effects (run a shell command,
//                        post a webhook, write a file). The host owns the
//                        runner; core only owns the trigger taxonomy and the
//                        result envelope so traces, policy, and UIs can stay
//                        consistent across hosts.
//
// Core deliberately does not execute shell commands here — that would
// re-import the environment-runner concern and conflate "what hook fires"
// with "how the hook is implemented". The CLI / server-runtime / desktop
// host attaches a runner that knows about its sandboxing, env, and timeout
// model.
//
// Triggers map to events emitted by the run loop. The host is responsible
// for subscribing the runner to the right event types — core just provides
// the trigger vocabulary and a helper to forward matching events.
//
// See docs/EXTENSION_INTERFACES.md "User Hooks".
// =============================================================================

import type { EventEmitter, SparkwrightEvent } from "./events.js";
import type { RunId } from "./ids.js";

/**
 * Trigger vocabulary for user-configured hooks. Modelled after the
 * lifecycle events most hosts already want to react to. Aligns 1:1 with
 * SparkwrightEvent.type values so a runner can subscribe directly.
 *
 * @public
 * @stability experimental v0.1
 */
export type UserHookTrigger =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "tool.requested"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.resolved"
  | "workspace.write.completed"
  | "artifact.created"
  | "interaction.requested";

/**
 * Origin of a user hook configuration. Lets traces and policy distinguish
 * hooks that came from a project-checked-in settings file from those a user
 * defined globally, from managed/enterprise-pinned ones. Follows a layered
 * settings-source taxonomy common in agent-CLI tooling.
 *
 * `managed` denotes admin-pinned hooks (e.g. organization policy file). When
 * `BindUserHooksOptions.allowManagedOnly` is set, only invocations whose
 * descriptor reports `source: "managed"` are forwarded to the runner.
 *
 * @public
 * @stability experimental v0.1
 */
export type UserHookSource =
  | "user"
  | "project"
  | "local"
  | "plugin"
  | "session"
  | "builtin"
  | "managed";

export interface UserHookInvocation<TPayload = unknown> {
  /** Stable hook identifier supplied by the host (e.g. "post-tool-bash"). */
  hookId: string;
  /** Display name shown in traces and UIs. */
  hookName: string;
  trigger: UserHookTrigger;
  runId: RunId;
  /** The originating event that triggered this invocation. */
  event: SparkwrightEvent<TPayload>;
  /** Free-form host-defined metadata (e.g. the configured command string). */
  metadata?: Record<string, unknown>;
  /**
   * Origin of the hook configuration. Optional for back-compat; hosts that
   * layer multiple settings files should populate it via `resolveDescriptor`
   * so traces and the `allowManagedOnly` policy can apply consistently.
   */
  source?: UserHookSource;
  /**
   * Aborts when the run is cancelled or torn down. Long-running runners
   * should observe it and return early instead of fighting the run lifecycle.
   * Always present even when no run-level abort signal was supplied so
   * runners can wire it unconditionally.
   */
  signal: AbortSignal;
  /**
   * Emit an interim progress sample for a long-running invocation. Each call
   * publishes a `user_hook.progress` event on the run's event log. Cheap to
   * call; no-op once the runner returns. Optional — short hooks can ignore it.
   * @reserved Public hook-runner helper consumed by host hook adapters.
   */
  reportProgress(chunk: UserHookProgressChunk): void;
}

/**
 * Snapshot of a long-running hook's interim output. Uses the conventional
 * (stdout, stderr, output) shape so a host wrapping a shell command can pass
 * captured streams straight through without re-encoding.
 *
 * @public
 * @stability experimental v0.1
 */
export interface UserHookProgressChunk {
  /** Newly captured stdout since the last progress emit (host's choice). */
  stdout?: string;
  /** Newly captured stderr since the last progress emit (host's choice). */
  stderr?: string;
  /** Free-form display string for UIs that don't care about stream split. */
  output?: string;
  /** Optional structured payload — escape hatch for non-shell runners. */
  data?: Record<string, unknown>;
}

export type UserHookOutcome =
  | { status: "ok"; durationMs: number; output?: string }
  | {
      status: "failed";
      durationMs: number;
      error: { code: string; message: string };
      output?: string;
    }
  | { status: "skipped"; reason: string };

/**
 * Host-supplied runner. The host owns execution (shell, subprocess, network
 * call). Core forwards matching events through {@link bindUserHooks} and
 * records outcomes as `user_hook.*` events on the run's event log.
 *
 * @public
 * @stability experimental v0.1
 */
export interface UserHookRunner {
  /**
   * Return the triggers this runner cares about. Used by
   * {@link bindUserHooks} to subscribe efficiently instead of dispatching
   * every event.
   */
  triggers(): UserHookTrigger[] | ReadonlySet<UserHookTrigger>;
  /**
   * Execute the host's configured action for this invocation. Errors thrown
   * here are caught and recorded as `user_hook.failed` events so a misbehaving
   * hook never aborts the run.
   */
  invoke(
    invocation: UserHookInvocation,
  ): Promise<UserHookOutcome> | UserHookOutcome;
}

export interface UserHookDescriptor {
  hookId: string;
  hookName: string;
  metadata?: Record<string, unknown>;
  source?: UserHookSource;
}

export interface BindUserHooksOptions {
  events: EventEmitter & {
    subscribe?: (handler: (event: SparkwrightEvent) => void) => () => void;
    subscribeWithReplay?: (
      handler: (event: SparkwrightEvent) => void,
    ) => () => void;
  };
  runner: UserHookRunner;
  /**
   * Override the hook id / name / source attached to invocations. Useful
   * when one runner instance handles multiple host-side declarations and
   * wants to label them distinctly per trigger.
   */
  resolveDescriptor?(
    trigger: UserHookTrigger,
    event: SparkwrightEvent,
  ): UserHookDescriptor;
  /**
   * Enterprise lock-down: when true, only invocations whose descriptor
   * reports `source: "managed"` are forwarded to the runner. Non-managed
   * hooks are silently dropped (no `user_hook.*` events emitted). Default:
   * `false`.
   */
  allowManagedOnly?: boolean;
  /**
   * Run-level abort signal forwarded into every {@link UserHookInvocation}.
   * Typically `RunHandle.abortSignal`. When omitted, invocations receive a
   * never-aborting signal so runners can wire `invocation.signal`
   * unconditionally.
   */
  signal?: AbortSignal;
  /**
   * When `true` (default), invocations replay events emitted before
   * `bindUserHooks` was called — closes the "host attached late and missed
   * `run.started`" gap. Pass `false` to restore strict future-only delivery.
   */
  replayPastEvents?: boolean;
}

/**
 * Wire a {@link UserHookRunner} to an event emitter. Returns an unsubscribe
 * function. Hosts typically call this once per run (or per session) right
 * after `createRun`, passing `run.events`.
 *
 * Implementation guarantees:
 *   - Invocations are sequential per-event but non-blocking across events.
 *     We don't await the runner before returning from the event listener,
 *     so a slow hook never stalls the run loop.
 *   - Failures from the runner are caught and re-emitted as
 *     `user_hook.failed` events; they never throw out of the event handler.
 *   - The runner is invoked at most once per matching event.
 *   - Past events are replayed synchronously on attach (opt-out via
 *     `replayPastEvents: false`) so late binders don't miss `run.started`.
 *
 * @public
 * @stability experimental v0.1
 */
export function bindUserHooks(options: BindUserHooksOptions): () => void {
  const { events } = options;
  if (
    typeof events.subscribe !== "function" &&
    typeof events.subscribeWithReplay !== "function"
  ) {
    throw new Error(
      "bindUserHooks requires an EventEmitter that exposes subscribe()",
    );
  }
  const triggers = new Set(options.runner.triggers());
  if (triggers.size === 0) return () => undefined;

  const allowManagedOnly = options.allowManagedOnly === true;
  const replay = options.replayPastEvents !== false;
  const runSignal = options.signal ?? NEVER_ABORTED_SIGNAL;

  const dispatch = (event: SparkwrightEvent): void => {
    if (!triggers.has(event.type as UserHookTrigger)) return;
    const descriptor: UserHookDescriptor = options.resolveDescriptor
      ? options.resolveDescriptor(event.type as UserHookTrigger, event)
      : { hookId: `${event.type}:default`, hookName: event.type };

    if (allowManagedOnly && descriptor.source !== "managed") {
      // Policy drop — do not emit any user_hook.* events for non-managed
      // hooks under lock-down (managed-only enforcement).
      return;
    }

    const invocation: UserHookInvocation = {
      hookId: descriptor.hookId,
      hookName: descriptor.hookName,
      trigger: event.type as UserHookTrigger,
      runId: event.runId,
      event,
      metadata: descriptor.metadata,
      source: descriptor.source,
      signal: runSignal,
      reportProgress: (chunk) => {
        events.emit("user_hook.progress", {
          hookId: descriptor.hookId,
          hookName: descriptor.hookName,
          trigger: event.type as UserHookTrigger,
          runId: event.runId,
          source: descriptor.source,
          ...chunk,
        });
      },
    };

    events.emit("user_hook.invoked", {
      hookId: invocation.hookId,
      hookName: invocation.hookName,
      trigger: invocation.trigger,
      runId: invocation.runId,
      eventId: event.id,
      source: descriptor.source,
    });

    Promise.resolve()
      .then(() => options.runner.invoke(invocation))
      .then((outcome) => {
        if (outcome.status === "failed") {
          events.emit("user_hook.failed", {
            hookId: invocation.hookId,
            hookName: invocation.hookName,
            trigger: invocation.trigger,
            runId: invocation.runId,
            source: descriptor.source,
            durationMs: outcome.durationMs,
            error: outcome.error,
            output: outcome.output,
          });
          return;
        }
        if (outcome.status === "skipped") {
          events.emit("user_hook.completed", {
            hookId: invocation.hookId,
            hookName: invocation.hookName,
            trigger: invocation.trigger,
            runId: invocation.runId,
            source: descriptor.source,
            skipped: true,
            reason: outcome.reason,
          });
          return;
        }
        events.emit("user_hook.completed", {
          hookId: invocation.hookId,
          hookName: invocation.hookName,
          trigger: invocation.trigger,
          runId: invocation.runId,
          source: descriptor.source,
          durationMs: outcome.durationMs,
          output: outcome.output,
        });
      })
      .catch((cause: unknown) => {
        events.emit("user_hook.failed", {
          hookId: invocation.hookId,
          hookName: invocation.hookName,
          trigger: invocation.trigger,
          runId: invocation.runId,
          source: descriptor.source,
          error: {
            code: "USER_HOOK_THREW",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });
  };

  if (replay && typeof events.subscribeWithReplay === "function") {
    return events.subscribeWithReplay(dispatch);
  }
  // Older / minimal emitters: fall back to plain subscribe; replay just won't
  // happen, which matches the pre-replay behaviour.
  return events.subscribe!(dispatch);
}

/**
 * A sentinel `AbortSignal` that never aborts. Used as the default for
 * `UserHookInvocation.signal` when the host did not supply a run-level
 * cancellation signal, so runners can always wire `invocation.signal`
 * without a null check.
 */
const NEVER_ABORTED_SIGNAL: AbortSignal = (() => {
  const controller = new AbortController();
  return controller.signal;
})();
