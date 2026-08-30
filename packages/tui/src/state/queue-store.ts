/**
 * Prompt queue for in-flight runs.
 *
 * While a run is active the host can only accept one goal at a time, but a
 * user often knows the next two or three things they want to ask. Rather than
 * block the input or make them wait and re-type, submissions during a run are
 * enqueued here; the App drains the head of the queue and starts it the moment
 * the current run finishes.
 *
 * UI subscribes via useSyncExternalStore. `getSnapshot` returns a stable array
 * reference that only changes when the queue changes (a fresh literal each
 * call would spin React into an update loop, the same trap ToastStore guards
 * against).
 */

type Listener = () => void;

export class QueueStore {
  private items: string[] = [];
  private listeners = new Set<Listener>();
  // Stable snapshot — identity changes only when the queue mutates.
  private snapshot: readonly string[] = [];

  getSnapshot = (): readonly string[] => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get size(): number {
    return this.items.length;
  }

  /** Append a prompt to the back of the queue. Blank input is ignored. */
  enqueue(text: string): void {
    if (!text.trim()) return;
    this.items.push(text);
    this.emit();
  }

  /** Remove and return the head of the queue (next to run), or undefined. */
  dequeue(): string | undefined {
    if (this.items.length === 0) return undefined;
    const head = this.items.shift();
    this.emit();
    return head;
  }

  /** Remove and return the most recently queued item (for "edit last"). */
  removeLast(): string | undefined {
    if (this.items.length === 0) return undefined;
    const last = this.items.pop();
    this.emit();
    return last;
  }

  /** Remove the item at `index`; no-op if out of range. */
  removeAt(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  private emit(): void {
    this.snapshot = this.items.slice();
    for (const l of this.listeners) l();
  }
}
