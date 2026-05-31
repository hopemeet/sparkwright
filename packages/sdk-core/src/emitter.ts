/**
 * Tiny typed event emitter. Replaces node:events.EventEmitter so this
 * package stays runtime-agnostic (works in both Node and browser without
 * polyfills).
 *
 * Listener semantics match EventEmitter for the subset we use: multiple
 * listeners per event, .on / .off / .emit, errors thrown in a listener
 * are caught and dropped (not rethrown — one bad listener should not
 * break the others).
 */
export class TypedEmitter<TEvents extends Record<string, unknown[]>> {
  private listeners: {
    [K in keyof TEvents]?: Array<(...args: TEvents[K]) => void>;
  } = {};

  on<K extends keyof TEvents>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  off<K extends keyof TEvents>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): this {
    const arr = this.listeners[event];
    if (!arr) return this;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  emit<K extends keyof TEvents>(event: K, ...args: TEvents[K]): boolean {
    const arr = this.listeners[event];
    if (!arr || arr.length === 0) return false;
    // Snapshot to avoid mutation during iteration if a listener unsubscribes.
    for (const fn of [...arr]) {
      try {
        fn(...args);
      } catch {
        /* swallow: one bad listener doesn't break the rest */
      }
    }
    return true;
  }
}
