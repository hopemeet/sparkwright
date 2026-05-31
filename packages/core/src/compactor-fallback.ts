// =============================================================================
// compactor-fallback.ts — Error-tolerant wrapper for the Compactor protocol.
//
// Why: a compactor that throws (provider 5xx, JSON parse error, abort)
// must not propagate that failure into the run loop. The kernel position
// is "compaction is best-effort": when it fails, return the input
// unchanged, optionally cool down for a while, and keep the run alive.
//
// Behaviour:
// - On error, try `fallback.compact` once if provided.
// - If the fallback also fails (or wasn't provided), return the input
//   list untouched.
// - After a failure, enter a cooldown window during which `compact`
//   short-circuits without calling the underlying compactor again.
// - Every transition fires `onEvent` so the host can attach trace events
//   or surface a UI hint.
//
// The wrapper intentionally does NOT inspect HTTP statuses or specific
// error codes. Provider adapters (provider-ai-sdk, etc.) own that
// classification — the kernel only sees `Error`.
// =============================================================================

import type { Compactor, ContextHints } from "./context.js";
import type { ContextItem } from "./types.js";

export type CompactorFallbackPhase = "primary" | "fallback" | "skipped";

export interface CompactorFallbackEvent {
  phase: CompactorFallbackPhase;
  /** @reserved Public fallback-event field consumed by compaction diagnostics. */
  outcome: "ok" | "error";
  /** Captured error message (truncated to ~500 chars) when `outcome === "error"`. */
  error?: string;
  /** @reserved Public fallback-event field consumed by compaction diagnostics. */
  cooldownActive: boolean;
}

export interface CompactorFallbackOptions {
  /**
   * Optional second compactor to try if the primary throws. A common
   * pattern is `primary = model-backed`, `fallback = cheap-deterministic
   * (e.g. snip stage adapter)`.
   */
  fallback?: Compactor;
  /**
   * Milliseconds to wait after a failure before re-attempting the
   * primary. Defaults to 60_000ms. Set to 0 to disable cooldown.
   */
  cooldownMs?: number;
  /**
   * Hook fired on every phase transition. Host can route to its event
   * log, structured logger, or UI notifier. Must not throw.
   */
  onEvent?: (event: CompactorFallbackEvent) => void;
  /**
   * Inject a clock for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Wrap a Compactor so transient failures never propagate into the run
 * loop. See module header for behaviour details.
 *
 * @public
 * @stability experimental v0.1
 */
export function withCompactorFallback(
  primary: Compactor,
  options: CompactorFallbackOptions = {},
): Compactor {
  const cooldownMs = Math.max(0, options.cooldownMs ?? 60_000);
  const now = options.now ?? Date.now;
  const emit = options.onEvent;
  let cooldownUntil = 0;

  const isInCooldown = (): boolean => cooldownMs > 0 && now() < cooldownUntil;

  const enterCooldown = (): void => {
    if (cooldownMs > 0) cooldownUntil = now() + cooldownMs;
  };

  return {
    async compact(
      items: ContextItem[],
      hints: ContextHints,
    ): Promise<ContextItem[]> {
      if (isInCooldown()) {
        emit?.({
          phase: "skipped",
          outcome: "ok",
          cooldownActive: true,
        });
        return items;
      }

      try {
        const next = await primary.compact(items, hints);
        emit?.({
          phase: "primary",
          outcome: "ok",
          cooldownActive: false,
        });
        return next;
      } catch (primaryError) {
        const primaryMessage = describeError(primaryError);
        emit?.({
          phase: "primary",
          outcome: "error",
          error: primaryMessage,
          cooldownActive: false,
        });

        if (options.fallback) {
          try {
            const next = await options.fallback.compact(items, hints);
            emit?.({
              phase: "fallback",
              outcome: "ok",
              cooldownActive: false,
            });
            return next;
          } catch (fallbackError) {
            enterCooldown();
            emit?.({
              phase: "fallback",
              outcome: "error",
              error: describeError(fallbackError),
              cooldownActive: cooldownMs > 0,
            });
            return items;
          }
        }

        enterCooldown();
        return items;
      }
    },
  };
}

function describeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
