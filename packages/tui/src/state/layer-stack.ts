/**
 * Tiny modal/layer stack. Each layer has a name and a priority; only the
 * top layer's render is mounted, so its useInput hook captures keys cleanly
 * without us having to chain "if modal A is open, don't fire B" logic across
 * components.
 *
 * Layers are pushed by name, deduped (pushing the same name swaps payload
 * instead of stacking), and popped by name or by index.
 */

import type { ReactNode } from "react";

export type LayerName =
  | "approval"
  | "sessions"
  | "activity"
  | "model"
  | "fork"
  | "help"
  | "config"
  | "capabilities"
  | "create"
  | "skill-create"
  | "skill-update"
  | "skill-review"
  | "session-rename";

export interface LayerEntry<P = unknown> {
  name: LayerName;
  /** Higher priority floats to the top regardless of push order. */
  priority: number;
  /** Payload data the renderer consumes. */
  payload: P;
}

type Listener = () => void;

const PRIORITY: Record<LayerName, number> = {
  // Approval is the most important — it blocks the run; it MUST be on top.
  approval: 100,
  "session-rename": 70, // above sessions so it can stack
  activity: 65,
  sessions: 60,
  model: 58,
  fork: 62,
  capabilities: 57,
  create: 57,
  "skill-create": 57,
  "skill-update": 57,
  "skill-review": 57,
  help: 50,
  config: 50,
};

export class LayerStack {
  private layers: LayerEntry[] = [];
  private listeners = new Set<Listener>();

  getSnapshot = (): LayerEntry[] => this.layers;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  push<P>(name: LayerName, payload?: P): void {
    const i = this.layers.findIndex((l) => l.name === name);
    const entry: LayerEntry<P | undefined> = {
      name,
      priority: PRIORITY[name],
      payload,
    };
    let next: LayerEntry[];
    if (i >= 0) {
      next = this.layers.slice();
      next[i] = entry as LayerEntry;
    } else {
      next = this.layers.concat(entry as LayerEntry);
    }
    next.sort((a, b) => a.priority - b.priority);
    this.layers = next;
    this.emit();
  }

  pop(name?: LayerName): void {
    if (!name) {
      if (this.layers.length === 0) return;
      this.layers = this.layers.slice(0, -1);
    } else {
      this.layers = this.layers.filter((l) => l.name !== name);
    }
    this.emit();
  }

  toggle<P>(name: LayerName, payload?: P): void {
    if (this.layers.some((l) => l.name === name)) this.pop(name);
    else this.push(name, payload);
  }

  has(name: LayerName): boolean {
    return this.layers.some((l) => l.name === name);
  }

  top(): LayerEntry | null {
    return this.layers.length === 0
      ? null
      : this.layers[this.layers.length - 1];
  }

  clear(): void {
    this.layers = [];
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Convenience: type the renderer for a known layer. */
export type LayerRenderer = (entry: LayerEntry) => ReactNode;
