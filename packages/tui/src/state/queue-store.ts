/**
 * Prompt queue for in-flight runs.
 *
 * While a run is active, Host-scheduled follow-ups are mirrored here for
 * presentation while project commands and failed-admission fallbacks remain
 * locally owned. The App drains only local work after the current run settles;
 * Host-owned entries remain until a typed follow-up update arrives.
 *
 * UI subscribes via useSyncExternalStore. `getSnapshot` returns a stable array
 * reference that only changes when the queue changes (a fresh literal each
 * call would spin React into an update loop, the same trap ToastStore guards
 * against).
 */

type Listener = () => void;

export interface QueuedSubmission {
  readonly goal: string;
  /** Host-owned follow-up command identity, when the lane owns scheduling. */
  readonly commandId?: string;
  readonly projectCommand?: { readonly name: string; readonly rest?: string };
}

export class QueueStore {
  private items: QueuedSubmission[] = [];
  private listeners = new Set<Listener>();
  // Stable snapshot — identity changes only when the queue mutates.
  private snapshot: readonly QueuedSubmission[] = [];

  getSnapshot = (): readonly QueuedSubmission[] => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get size(): number {
    return this.items.length;
  }

  /** Append a prompt to the back of the queue. Blank input is ignored. */
  enqueue(text: string): void {
    this.enqueueSubmission({ goal: text });
  }

  /** Append a structured run submission for both scheduling and presentation. */
  enqueueSubmission(submission: QueuedSubmission): void {
    if (!submission.goal.trim()) return;
    this.items.push({
      goal: submission.goal,
      ...(submission.commandId ? { commandId: submission.commandId } : {}),
      ...(submission.projectCommand
        ? { projectCommand: { ...submission.projectCommand } }
        : {}),
    });
    this.emit();
  }

  /** Remove and return the head of the queue (next to run), or undefined. */
  dequeue(): string | undefined {
    return this.dequeueSubmission()?.goal;
  }

  /** Remove and return the next complete Host submission. */
  dequeueSubmission(): QueuedSubmission | undefined {
    if (this.items.length === 0) return undefined;
    const head = this.items.shift();
    this.emit();
    return head;
  }

  /** Dequeue only work still owned by the TUI; Host-managed follow-ups wait. */
  dequeueLocalSubmission(): QueuedSubmission | undefined {
    if (this.items[0]?.commandId) return undefined;
    return this.dequeueSubmission();
  }

  /** Remove and return the most recently queued item (for "edit last"). */
  removeLast(): string | undefined {
    if (this.items.length === 0) return undefined;
    const last = this.items.pop()?.goal;
    this.emit();
    return last;
  }

  /** Remove the item at `index`; no-op if out of range. */
  removeAt(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    this.emit();
  }

  removeByCommandId(commandId: string): boolean {
    const index = this.items.findIndex((item) => item.commandId === commandId);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.emit();
    return true;
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  private emit(): void {
    this.snapshot = this.items.map((item) => ({
      goal: item.goal,
      ...(item.commandId ? { commandId: item.commandId } : {}),
      ...(item.projectCommand
        ? { projectCommand: { ...item.projectCommand } }
        : {}),
    }));
    for (const l of this.listeners) l();
  }
}
