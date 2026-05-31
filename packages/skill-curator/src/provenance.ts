// AI maintenance note: Async context flag that lets downstream code
// distinguish "skill_manage(create) called by the foreground agent" (the
// skill belongs to the user) from "skill_manage(create) called by the
// background review fork" (the skill is agent-authored and the curator may
// touch it). Implemented as an AsyncLocalStorage-backed provenance flag.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SkillUsageRecorder } from "@sparkwright/skills";

interface ReviewContext {
  origin: "background_review";
  sessionId?: string;
  parentSessionId?: string;
}

const STORAGE = new AsyncLocalStorage<ReviewContext>();

/**
 * Run `fn` inside a "background review" context. Any call to
 * {@link isBackgroundReview} during `fn` returns true, including across
 * `await` boundaries. Use this to wrap the LLM fork that the curator drives.
 *
 * @public
 * @stability experimental v0.1
 */
export function runBackgroundReview<T>(
  fn: () => T | Promise<T>,
  opts: { sessionId?: string; parentSessionId?: string } = {},
): T | Promise<T> {
  const ctx: ReviewContext = { origin: "background_review", ...opts };
  return STORAGE.run(ctx, fn);
}

/**
 * True iff the calling code is inside a {@link runBackgroundReview} scope.
 *
 * @public
 * @stability experimental v0.1
 */
export function isBackgroundReview(): boolean {
  return STORAGE.getStore() !== undefined;
}

/**
 * Convenience: when called inside a background-review scope, mark the named
 * skill as agent-created on the supplied recorder (including the current
 * review's sessionId in metadata). No-op otherwise. Use this from a host's
 * `skill_manage(create)` handler so that only review-fork creations are
 * tagged.
 *
 * @public
 * @stability experimental v0.1
 */
export function markIfBackgroundReview(
  recorder: SkillUsageRecorder,
  name: string,
): boolean {
  const ctx = STORAGE.getStore();
  if (!ctx) return false;
  recorder.markAgentCreated(name, {
    origin: ctx.origin,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
  });
  return true;
}
