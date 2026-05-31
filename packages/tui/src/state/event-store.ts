import type { RunEvent } from "../lib/event-type.js";

export type Status =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "done"
  | "error";

/**
 * Approval kind helps the UI choose the right body. The host emits a free-form
 * `action` string today; we normalise to a small enum the renderer switches on
 * and keep the original action for display.
 */
export type ApprovalKind =
  | "workspace.write"
  | "tool.execute"
  | "shell.execute"
  | "other";

export interface PendingApproval {
  id: string;
  action: string;
  kind: ApprovalKind;
  summary: string;
  /** Path for workspace.write; primary file for the diff. */
  path?: string;
  /** Free-form reason the tool/write was requested. */
  reason?: string;
  /** Unified diff body (workspace.write only). */
  diff?: string;
  /** Tool name (tool.execute / shell.execute). */
  toolName?: string;
  /** Captured tool args/metadata for display. Trimmed/serialised in renderer. */
  toolArgs?: unknown;
  /** Shell command, if shell.execute. */
  command?: string;
  /** Policy decision metadata (risk, reason). */
  policy?: {
    decision?: string;
    reason?: string;
    risk?: string;
  };
}

/**
 * Per-file modification accumulated from workspace.write events for the sidebar.
 * `additions`/`deletions` are best-effort counted from diff hunks; counts of 0
 * mean either no diff was emitted or the write was denied / pending.
 */
export interface ModifiedFile {
  path: string;
  additions: number;
  deletions: number;
  status: "requested" | "applied" | "denied";
  lastSeq: number;
}

export interface UsageSummary {
  /**
   * Live context size = the most recent model call's input tokens. NOT summed
   * across calls; reflects how full the window currently is.
   */
  contextTokens?: number;
  /** Session-cumulative input tokens (summed across every call/turn). */
  inputTokens?: number;
  /** Session-cumulative prompt-cache read tokens (subset of inputTokens). */
  cachedTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  /** Model invocations so far this session. */
  modelCalls?: number;
  /** Tool invocations so far this session. */
  toolCalls?: number;
}

export interface StoreState {
  status: Status;
  events: RunEvent[];
  pendingApproval: PendingApproval | null;
  lastError: string | null;
  stopReason: string | null;
  /** Live-assembled assistant text from `model.stream.chunk` (text_delta). */
  streamingText: string;
  /**
   * Live-assembled reasoning/thinking text, accumulated from stream chunks
   * that carry it (`type: "reasoning"`/`"reasoning_delta"`, or a `reasoning`
   * field). The deterministic core doesn't surface reasoning content today, so
   * this stays empty there; the plumbing is in place so a reasoning-capable
   * provider lights up the thinking block with no further wiring.
   */
  reasoningText: string;
  /** Stable id of the current logical session (set by RunController). */
  sessionId: string | null;
  /** Wall-clock ms when the current run started; null when not running. */
  runStartedAt: number | null;
  /** Wall-clock ms when the current run ended (success or error). */
  runEndedAt: number | null;
  /** Files modified within the current session (accumulated). Sidebar uses this. */
  modifiedFiles: ModifiedFile[];
  /** Latest usage snapshot, if the host emitted any usage event. */
  usage: UsageSummary | null;
  /**
   * Name of the tool currently in flight, or null. Set on tool.requested/
   * started, cleared on completed/failed. Drives a live "running X…" hint in
   * the live frame so the dead air before the first streamed token isn't blank.
   */
  activeTool: string | null;
  /**
   * Bumped by clearEvents()/reset(). The App keys <Static> off this and wipes
   * the terminal scrollback when it changes — Static can't un-print committed
   * lines on its own, so a visible /clear needs both a remount and a screen
   * wipe.
   */
  clearGeneration: number;
}

type Listener = () => void;

export class EventStore {
  private state: StoreState = {
    status: "idle",
    events: [],
    pendingApproval: null,
    lastError: null,
    stopReason: null,
    streamingText: "",
    reasoningText: "",
    sessionId: null,
    runStartedAt: null,
    runEndedAt: null,
    modifiedFiles: [],
    usage: null,
    activeTool: null,
    clearGeneration: 0,
  };
  private listeners = new Set<Listener>();
  private flushScheduled = false;
  /**
   * Per-run usage snapshots keyed by runId. Each run's UsageTracker resets to
   * zero every turn, so we keep the latest snapshot per run and sum across them
   * for session totals — never double-counting a run's intermediate snapshots.
   */
  private usageByRun = new Map<string, RunUsage>();
  private lastUsageRunId: string | null = null;
  // Synthetic, TUI-local events (e.g. the injected user goal) use descending
  // negative sequences so they never collide with host sequences (which start
  // at 1) and sort ahead of them when appended just before a run begins.
  private syntheticSeq = -1;

  getSnapshot = (): StoreState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setStatus(status: Status): void {
    let { runStartedAt, runEndedAt } = this.state;
    if (status === "running" && this.state.status !== "running") {
      runStartedAt = Date.now();
      runEndedAt = null;
    } else if (
      (status === "done" || status === "error") &&
      this.state.status === "running"
    ) {
      runEndedAt = Date.now();
    }
    this.state = { ...this.state, status, runStartedAt, runEndedAt };
    this.schedule();
  }

  setError(message: string): void {
    this.state = { ...this.state, status: "error", lastError: message };
    this.schedule();
  }

  setStopReason(reason: string | null): void {
    this.state = { ...this.state, stopReason: reason };
    this.schedule();
  }

  setSessionId(id: string | null): void {
    this.state = { ...this.state, sessionId: id };
    this.schedule();
  }

  appendEvent(event: RunEvent): void {
    if (event.type === "model.stream.chunk") {
      const chunk = event.payload as {
        type?: string;
        text?: string;
        reasoning?: string;
      } | null;
      if (
        chunk &&
        chunk.type === "text_delta" &&
        typeof chunk.text === "string"
      ) {
        this.state = {
          ...this.state,
          streamingText: this.state.streamingText + chunk.text,
        };
        this.schedule();
      } else if (chunk) {
        // Reasoning/thinking deltas, if the provider emits them. Accept either a
        // dedicated chunk type or a `reasoning` field on any chunk.
        const reasoning =
          (chunk.type === "reasoning" || chunk.type === "reasoning_delta") &&
          typeof chunk.text === "string"
            ? chunk.text
            : typeof chunk.reasoning === "string"
              ? chunk.reasoning
              : null;
        if (reasoning) {
          this.state = {
            ...this.state,
            reasoningText: this.state.reasoningText + reasoning,
          };
          this.schedule();
        }
      }
      return;
    }
    if (event.type === "model.stream.started") {
      this.state = { ...this.state, streamingText: "", reasoningText: "" };
    } else if (
      event.type === "model.stream.completed" ||
      event.type === "model.completed"
    ) {
      // The assistant turn has finished. Drop the live previews — the committed
      // `model.completed` card now carries the text in scrollback, so keeping
      // streamingText would duplicate it. Reasoning is ephemeral by design.
      this.state = { ...this.state, streamingText: "", reasoningText: "" };
    }

    // Append-only: <Static> slices from the previous items.length, so trimming
    // the front would silently drop newly-appended events. Per-session growth
    // is bounded by reset()/clearEvents() (/new, /clear), and each event is a
    // small object, so we keep the full session in memory.
    const events = this.state.events.concat(event);

    // Side-effect projections: keep specialised slices in sync so sidebar /
    // status bar can render off snapshot fields rather than re-scanning events.
    let modifiedFiles = this.state.modifiedFiles;
    let usage = this.state.usage;
    let activeTool = this.state.activeTool;

    if (event.type === "tool.requested" || event.type === "tool.started") {
      const name = (rec(event.payload).toolName ?? null) as string | null;
      if (typeof name === "string") activeTool = name;
    } else if (
      // Batch mode (deterministic provider) emits tool.batch.completed rather
      // than per-tool completions, and a new model turn / stream supersedes any
      // in-flight tool — clear on all of these so the live hint can't stick.
      event.type === "tool.completed" ||
      event.type === "tool.failed" ||
      event.type === "tool.batch.completed" ||
      event.type === "model.requested" ||
      event.type === "model.completed" ||
      event.type === "model.stream.started"
    ) {
      activeTool = null;
    }

    if (event.type.startsWith("workspace.write")) {
      const payload = (event.payload ?? {}) as {
        path?: string;
        diff?: string;
      };
      const path = typeof payload.path === "string" ? payload.path : null;
      if (path) {
        const status: ModifiedFile["status"] = event.type.endsWith(".denied")
          ? "denied"
          : event.type.endsWith(".applied") || event.type.endsWith(".completed")
            ? "applied"
            : "requested";
        const { adds, dels } =
          typeof payload.diff === "string"
            ? countDiffLines(payload.diff)
            : { adds: 0, dels: 0 };
        modifiedFiles = upsertModifiedFile(modifiedFiles, {
          path,
          additions: adds,
          deletions: dels,
          status,
          lastSeq: event.sequence ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }

    if (event.type === "usage.updated") {
      usage = this.foldUsage(event.payload);
    }

    this.state = { ...this.state, events, modifiedFiles, usage, activeTool };
    this.schedule();
  }

  /**
   * Commit the user's goal as a synthetic transcript entry. The host's
   * `run.started` payload carries the goal only for the streaming provider
   * (the deterministic core emits an empty payload), so the controller — which
   * always knows the goal — injects it here. Rendered as a "user" card;
   * `run.started` itself is hidden by the renderer to avoid a duplicate.
   */
  appendUserMessage(text: string): void {
    const event = {
      type: "tui.user",
      sequence: this.syntheticSeq--,
      id: `user_${Date.now().toString(36)}_${(-this.syntheticSeq).toString(36)}`,
      payload: { goal: text },
    } as RunEvent;
    this.state = { ...this.state, events: this.state.events.concat(event) };
    this.schedule();
  }

  setPendingApproval(pending: PendingApproval | null): void {
    this.state = {
      ...this.state,
      pendingApproval: pending,
      status: pending ? "awaiting-approval" : "running",
    };
    this.schedule();
  }

  /** Clear visible events but keep sessionId. Used by /clear. */
  clearEvents(): void {
    this.state = {
      ...this.state,
      events: [],
      streamingText: "",
      reasoningText: "",
      lastError: null,
      stopReason: null,
      status: this.state.status === "running" ? "running" : "idle",
      modifiedFiles: [],
      activeTool: null,
      clearGeneration: this.state.clearGeneration + 1,
    };
    this.schedule();
  }

  /** Full reset including session. Used by /new. */
  reset(): void {
    this.usageByRun.clear();
    this.lastUsageRunId = null;
    this.state = {
      status: "idle",
      events: [],
      pendingApproval: null,
      lastError: null,
      stopReason: null,
      streamingText: "",
      reasoningText: "",
      sessionId: null,
      runStartedAt: null,
      runEndedAt: null,
      modifiedFiles: [],
      usage: null,
      activeTool: null,
      clearGeneration: this.state.clearGeneration + 1,
    };
    this.schedule();
  }

  /**
   * Fold a `usage.updated` snapshot into the session totals. Each run resets
   * its tracker to zero per turn, so we keep the latest snapshot per runId and
   * sum across runs. `contextTokens` is taken from the most-recent run only —
   * it's the live window size, not a cumulative figure.
   */
  private foldUsage(rawPayload: unknown): UsageSummary | null {
    const run = parseRunUsage(rawPayload);
    if (!run) return this.state.usage;

    this.usageByRun.set(run.runId, run);
    this.lastUsageRunId = run.runId;

    const totals = {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      estimatedCostUsd: 0,
    };
    for (const r of this.usageByRun.values()) {
      totals.modelCalls += r.modelCalls;
      totals.toolCalls += r.toolCalls;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.totalTokens += r.totalTokens;
      totals.cachedTokens += r.cachedTokens;
      totals.estimatedCostUsd += r.costUsd;
    }
    const last =
      this.lastUsageRunId === null
        ? undefined
        : this.usageByRun.get(this.lastUsageRunId);
    return { ...totals, contextTokens: last?.contextTokens ?? 0 };
  }

  private schedule(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** First finite number among the candidates (0 counts), else undefined. */
function firstNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** A single run's latest usage snapshot, normalised from the host payload. */
interface RunUsage {
  runId: string;
  modelCalls: number;
  toolCalls: number;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/**
 * Normalise a `usage.updated` payload (core's UsageSnapshot) into a RunUsage.
 * Reads the snapshot shape `{ tokens: { input, output, total, cached },
 * modelCalls, toolCalls, contextTokens, costUsd }` first, then falls back to
 * legacy nested/flat and provider-native field names so any source lights up
 * the panel. Returns null when the payload carries no usable token numbers.
 */
function parseRunUsage(rawPayload: unknown): RunUsage | null {
  const payload = rec(rawPayload);
  const src = "usage" in payload ? rec(payload.usage) : payload;
  const tokens = rec(src.tokens);

  const inputTokens = firstNum(src.inputTokens, tokens.input, src.promptTokens);
  const outputTokens = firstNum(
    src.outputTokens,
    tokens.output,
    src.completionTokens,
  );
  const totalTokens =
    firstNum(src.totalTokens, tokens.total) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const runId = typeof src.runId === "string" ? src.runId : "_";
  return {
    runId,
    modelCalls: firstNum(src.modelCalls) ?? 0,
    toolCalls: firstNum(src.toolCalls) ?? 0,
    contextTokens: firstNum(src.contextTokens, tokens.input) ?? 0,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    cachedTokens: firstNum(tokens.cached, src.cacheReadTokens) ?? 0,
    costUsd: firstNum(src.estimatedCostUsd, src.costUsd) ?? 0,
  };
}

/**
 * Count + / - lines in a unified diff (ignoring the `+++` / `---` headers).
 * Best-effort — we only need approximate sidebar numbers, not exact churn.
 */
function countDiffLines(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) dels += 1;
  }
  return { adds, dels };
}

/**
 * Last-write-wins per path: any new event for the same file replaces the
 * previous entry (so a deny → re-request → apply cycle ends up showing the
 * applied state). Keeps the list short and stable for the sidebar.
 */
function upsertModifiedFile(
  prev: ModifiedFile[],
  next: ModifiedFile,
): ModifiedFile[] {
  const i = prev.findIndex((m) => m.path === next.path);
  if (i === -1) return prev.concat(next);
  const merged: ModifiedFile = {
    ...prev[i],
    // Adopt new status; carry forward counts if the new event lacked a diff.
    status: next.status,
    additions: next.additions || prev[i].additions,
    deletions: next.deletions || prev[i].deletions,
    lastSeq: Math.max(prev[i].lastSeq, next.lastSeq),
  };
  const out = prev.slice();
  out[i] = merged;
  return out;
}
