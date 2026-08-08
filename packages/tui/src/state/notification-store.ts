import {
  presentationPolicy,
  type UiSignal,
  type UiSignalInput,
  type UiSignalKind,
  type UiSignalScope,
} from "../lib/ui-signal.js";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastInput {
  title?: string;
  message: string;
  variant?: ToastVariant;
  durationMs?: number | null;
  source?: string;
  scope?: UiSignalScope;
  dedupeKey?: string;
}

export interface Toast extends UiSignal {
  variant: ToastVariant;
}

export interface NotificationSnapshot {
  current: Toast | null;
  queueDepth: number;
  /** @reserved Public lifecycle count for notification-center/badge consumers. */
  unreadCount: number;
  /** @reserved Public lifecycle count for notification-center/badge consumers. */
  unresolvedCount: number;
  history: readonly UiSignal[];
}

type Listener = () => void;
type SignalListener = (signal: UiSignal) => void;

const EMPTY_SNAPSHOT: NotificationSnapshot = {
  current: null,
  queueDepth: 0,
  unreadCount: 0,
  unresolvedCount: 0,
  history: [],
};

/**
 * Unified in-memory presentation signal store. Host events and session traces
 * remain canonical; this store owns only TUI lifecycle (dedupe, unread,
 * resolved, toast projection, and attention subscriptions).
 */
export class NotificationStore {
  private queue: Toast[] = [];
  private current: Toast | null = null;
  private history: UiSignal[] = [];
  private listeners = new Set<Listener>();
  private signalListeners = new Set<SignalListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private snapshot: NotificationSnapshot = EMPTY_SNAPSHOT;

  getSnapshot = (): NotificationSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onSignal(listener: SignalListener): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  push(input: ToastInput): void {
    const kind = kindFromVariant(input.variant ?? "info");
    const scope =
      input.scope ?? (kind === "error" ? "ActionFailure" : "ActionSuccess");
    const policy = presentationPolicy({ kind, scope });
    this.publish({
      kind,
      scope,
      source: input.source ?? "tui.action",
      title: input.title,
      message: input.message,
      persistence: policy.persistence,
      attention: policy.attention,
      presentation: policy.presentation,
      durationMs:
        input.durationMs === undefined ? policy.durationMs : input.durationMs,
      dedupeKey: input.dedupeKey,
    });
  }

  publish(input: UiSignalInput): string {
    const now = input.createdAt ?? Date.now();
    const existing = input.dedupeKey
      ? this.history.find(
          (signal) => !signal.resolved && signal.dedupeKey === input.dedupeKey,
        )
      : undefined;
    const signal: UiSignal = existing
      ? {
          ...existing,
          ...input,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now,
          seen: false,
          resolved: false,
        }
      : {
          ...input,
          id: input.id ?? `ui_${this.nextId++}`,
          createdAt: now,
          updatedAt: now,
          seen: false,
          resolved: false,
        };

    if (existing) {
      this.history = this.history.map((item) =>
        item.id === signal.id ? signal : item,
      );
      this.queue = this.queue.map((item) =>
        item.id === signal.id ? toToast(signal) : item,
      );
      if (this.current?.id === signal.id) {
        this.show(toToast(signal), false);
      }
    } else {
      this.history = this.history.concat(signal);
    }

    if (input.presentation.includes("toast")) {
      const toast = toToast(signal);
      if (!this.current) {
        this.show(toast, false);
      } else if (
        toast.variant === "error" &&
        this.current.variant !== "error"
      ) {
        const previous = this.current;
        this.clearTimer();
        this.queue.unshift(previous);
        this.show(toast, false);
      } else if (!existing || this.current?.id !== signal.id) {
        const queueIndex = this.queue.findIndex(
          (item) => item.id === signal.id,
        );
        if (queueIndex < 0) this.queue.push(toast);
      }
    }

    this.emit();
    for (const listener of this.signalListeners) listener(signal);
    return signal.id;
  }

  dismiss(): void {
    if (this.current) this.markSeen(this.current.id, false);
    this.clearTimer();
    const next = this.queue.shift() ?? null;
    if (next) this.show(next, true);
    else {
      this.current = null;
      this.emit();
    }
  }

  markSeen(id: string, emit = true): void {
    this.history = this.history.map((signal) =>
      signal.id === id
        ? {
            ...signal,
            seen: true,
            resolved:
              signal.persistence === "transient" ||
              signal.persistence === "until-seen"
                ? true
                : signal.resolved,
          }
        : signal,
    );
    if (emit) this.emit();
  }

  markAllSeen(): void {
    const hasUnread = this.history.some(
      (signal) => !signal.seen && !signal.resolved,
    );
    if (!hasUnread) return;
    this.history = this.history.map((signal) =>
      signal.seen
        ? signal
        : {
            ...signal,
            seen: true,
            resolved:
              signal.persistence === "transient" ||
              signal.persistence === "until-seen"
                ? true
                : signal.resolved,
          },
    );
    const byId = new Map(this.history.map((signal) => [signal.id, signal]));
    this.queue = this.queue
      .map((toast) => toToast(byId.get(toast.id) ?? toast))
      .filter((toast) => !toast.resolved);
    if (this.current) {
      const updated = byId.get(this.current.id);
      if (updated?.resolved) {
        this.clearTimer();
        const next = this.queue.shift();
        this.current = next ?? null;
        if (next) this.show(next, false);
      } else if (updated) {
        this.current = toToast(updated);
      }
    }
    this.emit();
  }

  resolve(idOrDedupeKey: string): void {
    const ids = new Set(
      this.history
        .filter(
          (signal) =>
            signal.id === idOrDedupeKey || signal.dedupeKey === idOrDedupeKey,
        )
        .map((signal) => signal.id),
    );
    if (ids.size === 0) return;
    this.history = this.history.map((signal) =>
      ids.has(signal.id)
        ? { ...signal, seen: true, resolved: true, updatedAt: Date.now() }
        : signal,
    );
    this.queue = this.queue.filter((signal) => !ids.has(signal.id));
    if (this.current && ids.has(this.current.id)) {
      this.clearTimer();
      this.current = null;
      const next = this.queue.shift();
      if (next) this.show(next, false);
    }
    this.emit();
  }

  private show(toast: Toast, emit: boolean): void {
    this.current = toast;
    this.clearTimer();
    if (toast.durationMs && toast.durationMs > 0) {
      this.timer = setTimeout(() => this.dismiss(), toast.durationMs);
    }
    if (emit) this.emit();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(): void {
    this.snapshot = {
      current: this.current,
      queueDepth: this.queue.length,
      unreadCount: this.history.filter(
        (signal) => !signal.seen && !signal.resolved,
      ).length,
      unresolvedCount: this.history.filter((signal) => !signal.resolved).length,
      history: this.history,
    };
    for (const listener of this.listeners) listener();
  }
}

function kindFromVariant(variant: ToastVariant): UiSignalKind {
  return variant;
}

function variantFromKind(kind: UiSignalKind): ToastVariant {
  if (kind === "error") return "error";
  if (kind === "warning" || kind === "action-required" || kind === "blocking") {
    return "warning";
  }
  if (kind === "success") return "success";
  return "info";
}

function toToast(signal: UiSignal): Toast {
  return { ...signal, variant: variantFromKind(signal.kind) };
}
