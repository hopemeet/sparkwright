// =============================================================================
// session-context.ts — AsyncLocalStorage-backed session/run context.
//
// Mirrors the pattern established by spans.ts. Why a dedicated module:
// tools, hooks, prompt sections, and provider adapters often need to know
// "which session / run am I currently inside" without taking an explicit
// parameter — but if that lookup goes through a global mutable variable,
// concurrent runs in the same process clobber each other.
//
// Concurrent jobs can otherwise race when session state is stored globally.
// A server runtime executing two `createRun` calls in parallel needs each
// async call tree to keep its own context. ALS
// gives each async call tree its own copy automatically.
//
// Only the context shape is opinionated. Hosts decide what fields they
// need and pass arbitrary extras via `metadata`.
// =============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

import type { RunId, SessionId } from "./ids.js";

/**
 * Ambient session/run information available to code running inside
 * `runWithSessionContext`. All optional except so hosts can populate
 * only what they have at the boundary.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SessionContext {
  readonly sessionId?: SessionId;
  readonly runId?: RunId;
  /**
   * Free-form channel identifier — IM gateway, CLI terminal, IDE pane.
   * Tools that emit notifications use this to address the right surface.
   */
  readonly channel?: string;
  /**
   * Logical platform name (`"matrix"`, `"telegram"`, `"vscode"`, …).
   * Distinct from `channel` so a single platform can multiplex many
   * channels.
   */
  readonly platform?: string;
  /**
   * User-facing identifier (chat id, workspace path…). Surfaced as-is in
   * audit trails; hosts MUST NOT put credentials here.
   */
  readonly origin?: string;
  /** Embedder-defined extras. Treated as opaque by the kernel. */
  readonly metadata?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<SessionContext>();

/**
 * Run `fn` with `context` installed as the active session context. Any
 * code in the async call tree (awaits, microtasks, setImmediate,
 * setTimeout, child promises) sees this context via
 * {@link currentSessionContext}. Sibling tasks running concurrently in
 * the same process keep their own copies — no shared mutable state.
 *
 * @public
 * @stability experimental v0.1
 */
export function runWithSessionContext<T>(
  context: SessionContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/**
 * Return the active {@link SessionContext} for the current async call
 * tree, or `undefined` when no `runWithSessionContext` is on the stack.
 *
 * @public
 * @stability experimental v0.1
 */
export function currentSessionContext(): SessionContext | undefined {
  return storage.getStore();
}

/**
 * Shallow-merge `partial` over the active session context for the
 * duration of `fn`. Useful for hooks that want to enrich the context
 * (e.g. attaching a span-specific channel override) without forcing the
 * caller to reconstruct the parent fields.
 *
 * Returns whatever `fn` returns. Outside any active context, behaves as
 * `runWithSessionContext(partial, fn)`.
 *
 * @public
 * @stability experimental v0.1
 */
export function extendSessionContext<T>(
  partial: Partial<SessionContext>,
  fn: () => T,
): T {
  const current = storage.getStore();
  const next: SessionContext = current
    ? {
        ...current,
        ...partial,
        metadata: {
          ...(current.metadata ?? {}),
          ...(partial.metadata ?? {}),
        },
      }
    : (partial as SessionContext);
  return storage.run(next, fn);
}

/**
 * Capture the active context so it can be re-installed in a worker thread
 * or callback that lives outside the current async call tree.
 *
 * Typical use: `const snapshot = captureSessionContext(); queue.push(() => runWithSessionContext(snapshot, work));`
 *
 * @public
 * @stability experimental v0.1
 */
export function captureSessionContext(): SessionContext {
  return storage.getStore() ?? {};
}
