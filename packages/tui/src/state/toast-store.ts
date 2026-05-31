/**
 * Tiny toast queue. UI subscribes via useSyncExternalStore and reads
 * `currentToast`. Multiple `push()` calls queue; the next surfaces when the
 * current one expires or is dismissed.
 */

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastInput {
  title?: string;
  message: string;
  variant?: ToastVariant;
  /** ms before auto-dismiss; null = sticky. */
  durationMs?: number | null;
}

export interface Toast extends ToastInput {
  id: number;
  variant: ToastVariant;
  durationMs: number | null;
}

type Listener = () => void;

const DEFAULT_DURATION: Record<ToastVariant, number | null> = {
  info: 3500,
  success: 3000,
  warning: 5000,
  error: null, // sticky until next toast or dismiss
};

export class ToastStore {
  private queue: Toast[] = [];
  private current: Toast | null = null;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  // Cached so getSnapshot returns a stable reference between state changes.
  // useSyncExternalStore compares snapshots by identity every render; a fresh
  // object literal each call reads as "always changed" and spins React into a
  // "Maximum update depth exceeded" loop.
  private snapshot: { current: Toast | null; queueDepth: number } = {
    current: null,
    queueDepth: 0,
  };

  getSnapshot = (): { current: Toast | null; queueDepth: number } =>
    this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  push(input: ToastInput): void {
    const variant = input.variant ?? "info";
    const toast: Toast = {
      id: this.nextId++,
      title: input.title,
      message: input.message,
      variant,
      durationMs:
        input.durationMs === undefined
          ? DEFAULT_DURATION[variant]
          : input.durationMs,
    };
    if (!this.current) this.show(toast);
    else {
      this.queue.push(toast);
      this.refresh();
    }
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.queue.shift() ?? null;
    if (next) this.show(next);
    else {
      this.current = null;
      this.emit();
    }
  }

  private show(toast: Toast): void {
    this.current = toast;
    this.emit();
    if (this.timer) clearTimeout(this.timer);
    if (toast.durationMs && toast.durationMs > 0) {
      this.timer = setTimeout(() => this.dismiss(), toast.durationMs);
    }
  }

  private refresh(): void {
    this.snapshot = { current: this.current, queueDepth: this.queue.length };
  }

  private emit(): void {
    this.refresh();
    for (const l of this.listeners) l();
  }
}
