import type { ReactNode } from "react";
import type { ApprovalViewModel } from "../lib/approval-view-model.js";
import type { CreateCapabilityKind } from "../lib/create-capability.js";
import type { CapabilityView } from "../lib/layer-payload.js";
import type { ActivityTab } from "../lib/task-activity.js";

export interface LayerPayloads {
  approval: ApprovalViewModel;
  sessions: undefined;
  activity: { tab: ActivityTab };
  model: undefined;
  fork: undefined;
  help: undefined;
  workflow: { workflowId: string };
  config: undefined;
  notifications: undefined;
  capabilities: { view: CapabilityView };
  create: { kind?: CreateCapabilityKind };
  /** @reserved Typed route key consumed through LayerName by Skill action hooks/renderers. */
  "skill-update": { name?: string } | undefined;
  /** @reserved Typed route key consumed through LayerName by Skill action hooks/renderers. */
  "skill-review": undefined;
  "session-rename": undefined;
}

export type LayerName = keyof LayerPayloads;

export type LayerEntry = {
  [K in LayerName]: {
    name: K;
    payload: LayerPayloads[K];
    /** Stable opening order used only to order peers in the same route band. */
    openedAt: number;
  };
}[LayerName];

type Listener = () => void;
type PayloadArgs<K extends LayerName> = LayerPayloads[K] extends undefined
  ? [] | [undefined]
  : undefined extends LayerPayloads[K]
    ? [payload?: LayerPayloads[K]]
    : [payload: LayerPayloads[K]];

// Route order is an internal interaction contract. Callers choose semantic
// routes, never magic numeric priorities.
const ROUTE_ORDER: readonly (readonly LayerName[])[] = [
  ["help", "config", "notifications"],
  ["workflow"],
  ["capabilities", "create", "skill-update", "skill-review", "model"],
  ["sessions", "fork"],
  ["activity"],
  ["session-rename"],
  ["approval"],
];

const ROUTE_RANK = new Map<LayerName, number>(
  ROUTE_ORDER.flatMap((names, rank) => names.map((name) => [name, rank])),
);

/**
 * Typed modal/layer history. Only the top entry is mounted, so exactly one
 * blocking surface owns terminal input. Same-name pushes update the payload
 * without growing the history; approval always occupies the top route band.
 */
export class LayerStack {
  private layers: LayerEntry[] = [];
  private listeners = new Set<Listener>();
  private nextOpenedAt = 1;

  getSnapshot = (): LayerEntry[] => this.layers;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  push<K extends LayerName>(name: K, ...args: PayloadArgs<K>): void {
    const payload = args[0] as LayerPayloads[K];
    const current = this.layers.find((layer) => layer.name === name);
    const entry = {
      name,
      payload,
      openedAt: current?.openedAt ?? this.nextOpenedAt++,
    } as LayerEntry;
    const next = current
      ? this.layers.map((layer) => (layer.name === name ? entry : layer))
      : this.layers.concat(entry);
    next.sort(compareRoutes);
    this.layers = next;
    this.emit();
  }

  pop(name?: LayerName): void {
    if (!name) {
      if (this.layers.length === 0) return;
      this.layers = this.layers.slice(0, -1);
    } else {
      this.layers = this.layers.filter((layer) => layer.name !== name);
    }
    this.emit();
  }

  toggle<K extends LayerName>(name: K, ...args: PayloadArgs<K>): void {
    if (this.layers.some((layer) => layer.name === name)) this.pop(name);
    else this.push(name, ...args);
  }

  has(name: LayerName): boolean {
    return this.layers.some((layer) => layer.name === name);
  }

  top(): LayerEntry | null {
    return this.layers.at(-1) ?? null;
  }

  clear(): void {
    this.layers = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function compareRoutes(left: LayerEntry, right: LayerEntry): number {
  const rankDelta =
    (ROUTE_RANK.get(left.name) ?? 0) - (ROUTE_RANK.get(right.name) ?? 0);
  return rankDelta || left.openedAt - right.openedAt;
}

/** Convenience: type the renderer for a known layer. */
export type LayerRenderer = (entry: LayerEntry) => ReactNode;
