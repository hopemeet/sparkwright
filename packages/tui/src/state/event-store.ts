import type { RunEvent } from "../lib/event-type.js";
import type { ApprovalSubject } from "../lib/session-approval.js";

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
  | "skill.apply"
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
  /** Stable, fail-closed projection used to offer and match session rules. */
  subject: ApprovalSubject;
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

/**
 * One row of the todo ledger, projected from `todo_write` tool requests for the
 * sidebar panel. `todo_write` replaces the whole ledger, so the most recent
 * request's items are the current ledger.
 */
export interface TodoPanelItem {
  title: string;
  status: string;
  depth: number;
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

export type ActivePhaseKind = "model" | "tool" | "agent" | "compaction";

export interface ActivePhase {
  kind: ActivePhaseKind;
  /** Short live-frame label, e.g. "thinking" or "running shell". */
  message: string;
  key: string;
  priority: number;
  depth: number;
  startedSeq: number;
}

/**
 * Live-frame phase precedence — higher wins in {@link EventStore.deriveActivePhase}.
 *
 * `compaction` sits at the top: it's a blocking between-turns maintenance
 * pause that may itself spawn a summarizing model call, and the user should see
 * "compacting" rather than that inner "thinking". `agent` (a running subagent)
 * outranks `tool` on purpose: a subagent is launched by a delegate tool whose
 * `execute()` stays open for the child's entire run (streaming-runtime brackets
 * `tool.requested` → `tool.completed` around the awaited execute). Without this,
 * the delegate tool name would mask the agent the whole time it runs.
 * A queued — not yet started — agent and quiet model-thinking sit low because
 * something more concrete is usually in flight.
 */
const PHASE_PRIORITY = {
  compaction: 55,
  agentActive: 45,
  tool: 40,
  agentQueued: 20,
  model: 10,
} as const;

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
  /** Current todo ledger, projected from the latest todo_write. Sidebar uses this. */
  todoItems: TodoPanelItem[];
  /** Latest usage snapshot, if the host emitted any usage event. */
  usage: UsageSummary | null;
  /**
   * Current high-signal runtime phase. Derived from open model/tool/subagent/
   * validation lifecycle events; drives the live hint when no stream text is
   * being rendered.
   *
   * @reserved Public TUI store field consumed by App live-frame rendering.
   */
  activePhase: ActivePhase | null;
  /** Host-computed human-only follow-up action offered after a tool result. */
  pendingHumanAction: PendingHumanAction | null;
  /**
   * Bumped by clearEvents()/reset(). The App keys <Static> off this and wipes
   * the terminal scrollback when it changes — Static can't un-print committed
   * lines on its own, so a visible /clear needs both a remount and a screen
   * wipe.
   */
  clearGeneration: number;
}

export interface PendingHumanAction {
  kind: "skill_proposal_review";
  proposalId: string;
  reviewCommand: string;
  eligibility: "quick_apply" | "review_required" | "force_required";
  validationStatus: "passed";
  contentMode?: string;
  guardSeverity: "none" | "caution" | "dangerous";
  recommendedAction: "apply" | "review";
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
    todoItems: [],
    usage: null,
    activePhase: null,
    pendingHumanAction: null,
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
  private pendingTodoProposals = new Map<string, TodoPanelItem[]>();
  private openPhases = new Map<string, ActivePhase>();
  // Retry attempts seen for the current model turn, keyed by runId (all attempts
  // in a turn share it). Lets the model phase read "retrying (attempt N)" rather
  // than a plain "thinking" while a failed call is being re-issued. Cleared when
  // the turn reaches a real terminal (model.completed) or the run ends.
  private modelRetries = new Map<string, number>();
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
    if (status !== "running" && status !== "awaiting-approval") {
      this.openPhases.clear();
      this.modelRetries.clear();
    }
    this.state = {
      ...this.state,
      status,
      lastError:
        status === "running" || status === "done" ? null : this.state.lastError,
      runStartedAt,
      runEndedAt,
      activePhase: this.deriveActivePhase(),
    };
    this.schedule();
  }

  setError(message: string): void {
    this.openPhases.clear();
    this.modelRetries.clear();
    this.state = {
      ...this.state,
      status: "error",
      lastError: message,
      activePhase: null,
    };
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
    let todoItems = this.state.todoItems;
    let usage = this.state.usage;
    let pendingHumanAction = this.state.pendingHumanAction;
    this.updateActivePhases(event);

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

    // todo ledger projection: todo_write replaces the whole ledger, but a
    // request is only a proposal. The committed ledger changes only after the
    // tool completes without an explicit saved:false result. Keep the full
    // request items around because completion output may be summarized.
    if (event.type === "tool.requested") {
      const payload = rec(event.payload);
      if (payload.toolName === "todo_write") {
        const callId = todoToolCallId(payload);
        const args = rec(payload.arguments ?? payload.input ?? payload.args);
        const proposed = parseTodoPanelItems(args.items);
        if (callId && proposed) {
          this.pendingTodoProposals.set(callId, proposed);
        }
      }
    } else if (event.type === "tool.completed") {
      const payload = rec(event.payload);
      const offeredAction = parsePendingHumanAction(
        rec(payload.output ?? payload.result).humanAction,
      );
      if (offeredAction) pendingHumanAction = offeredAction;
      const callId = todoToolCallId(payload);
      const proposed = callId
        ? this.pendingTodoProposals.get(callId)
        : undefined;
      if (callId) this.pendingTodoProposals.delete(callId);
      if (proposed) {
        const output = rec(payload.output ?? payload.result);
        if (output.saved !== false) {
          todoItems = proposed;
        }
      } else {
        const output = rec(payload.output ?? payload.result);
        if (output.saved !== false) {
          const completedItems = parseTodoPanelItems(output.todos);
          if (completedItems) todoItems = completedItems;
        }
      }
    } else if (event.type === "tool.failed") {
      const callId = todoToolCallId(rec(event.payload));
      if (callId) this.pendingTodoProposals.delete(callId);
    }

    if (event.type === "usage.updated") {
      usage = this.foldUsage(event.payload);
    }

    this.state = {
      ...this.state,
      events,
      modifiedFiles,
      todoItems,
      usage,
      pendingHumanAction,
      activePhase: this.deriveActivePhase(),
    };
    this.schedule();
  }

  clearPendingHumanAction(proposalId?: string): void {
    const current = this.state.pendingHumanAction;
    if (!current || (proposalId && current.proposalId !== proposalId)) return;
    this.state = { ...this.state, pendingHumanAction: null };
    this.schedule();
  }

  /** Restore a durable Skill inbox item after TUI startup or capability create. */
  setPendingHumanAction(action: PendingHumanAction | null): void {
    this.state = { ...this.state, pendingHumanAction: action };
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

  /**
   * Append a calm, TUI-local divider line (not a host event). Used for the
   * workflow continuation banner ("↻ continuing …") so the user sees an
   * episode boundary without it looking like their own input.
   */
  appendNotice(text: string): void {
    const event = {
      type: "tui.notice",
      sequence: this.syntheticSeq--,
      id: `notice_${Date.now().toString(36)}_${(-this.syntheticSeq).toString(36)}`,
      payload: { text },
    } as RunEvent;
    this.state = { ...this.state, events: this.state.events.concat(event) };
    this.schedule();
  }

  /**
   * Append a copy-safe transcript export confirmation. The toast remains the
   * short-lived status cue; this event gives the saved path a permanent,
   * border-free line in native scrollback.
   */
  appendTranscriptExport(path: string): void {
    const event = {
      type: "tui.export.completed",
      sequence: this.syntheticSeq--,
      id: `export_${Date.now().toString(36)}_${(-this.syntheticSeq).toString(36)}`,
      payload: { path },
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
    this.pendingTodoProposals.clear();
    this.openPhases.clear();
    this.modelRetries.clear();
    this.state = {
      ...this.state,
      events: [],
      streamingText: "",
      reasoningText: "",
      lastError: null,
      stopReason: null,
      status: this.state.status === "running" ? "running" : "idle",
      modifiedFiles: [],
      todoItems: [],
      activePhase: null,
      pendingHumanAction: null,
      clearGeneration: this.state.clearGeneration + 1,
    };
    this.schedule();
  }

  /** Full reset including session. Used by /new. */
  reset(): void {
    this.usageByRun.clear();
    this.lastUsageRunId = null;
    this.pendingTodoProposals.clear();
    this.openPhases.clear();
    this.modelRetries.clear();
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
      todoItems: [],
      usage: null,
      activePhase: null,
      pendingHumanAction: null,
      clearGeneration: this.state.clearGeneration + 1,
    };
    this.schedule();
  }

  private updateActivePhases(event: RunEvent): void {
    switch (event.type) {
      case "model.turn.started":
      case "model.requested": {
        const retries = this.modelRetries.get(modelRetryKey(event)) ?? 0;
        this.openPhase({
          kind: "model",
          key: modelPhaseKey(event),
          message:
            retries > 0 ? `retrying (attempt ${retries + 1})` : "thinking",
          priority: PHASE_PRIORITY.model,
          depth: 0,
          startedSeq: eventSequence(event),
        });
        return;
      }
      case "model.retrying": {
        const retries = (this.modelRetries.get(modelRetryKey(event)) ?? 0) + 1;
        this.modelRetries.set(modelRetryKey(event), retries);
        // The preceding stream failure closed the model phase; reopen it now so
        // the gap before the retry's model.requested still reads "retrying".
        this.openPhase({
          kind: "model",
          key: modelPhaseKey(event),
          message: `retrying (attempt ${retries + 1})`,
          priority: PHASE_PRIORITY.model,
          depth: 0,
          startedSeq: eventSequence(event),
        });
        return;
      }
      case "model.turn.completed":
      case "model.completed": {
        // True terminal for the turn — drop the retry tally so the next turn
        // starts back at a plain "thinking".
        this.modelRetries.delete(modelRetryKey(event));
        this.closePhase("model", modelPhaseKey(event));
        return;
      }
      case "model.stream.failed":
      case "model.stream.timeout": {
        // Not terminal for the turn: a retry may follow, so keep the tally.
        this.closePhase("model", modelPhaseKey(event));
        return;
      }
      case "context.compaction.started": {
        this.openPhase({
          kind: "compaction",
          key: requiredPhaseKey("compaction", compactionPhaseKey(event), event),
          message: "compacting context",
          priority: PHASE_PRIORITY.compaction,
          depth: 0,
          startedSeq: eventSequence(event),
        });
        return;
      }
      case "context.compaction.completed":
      case "context.compaction.failed": {
        this.closePhase("compaction", compactionPhaseKey(event));
        return;
      }
      case "tool.requested":
      case "tool.started": {
        const payload = rec(event.payload);
        const name = firstString(payload.toolName) ?? "tool";
        this.openPhase({
          kind: "tool",
          key: requiredPhaseKey("tool", toolPhaseKey(event), event),
          message: `running ${name}`,
          priority: PHASE_PRIORITY.tool,
          depth: 0,
          startedSeq: eventSequence(event),
        });
        return;
      }
      case "tool.completed":
      case "tool.failed": {
        this.closePhase("tool", toolPhaseKey(event));
        return;
      }
      case "tool.batch.completed": {
        this.closeAllPhases("tool");
        return;
      }
      case "subagent.requested":
      case "subagent.started": {
        const meta = rec(event.metadata);
        const payload = rec(event.payload);
        const name =
          firstString(
            meta.agentName,
            payload.agentName,
            meta.childAgentId,
            meta.agentProfileId,
            meta.agentId,
            payload.childRunId,
          ) ?? "subagent";
        const queued = event.type === "subagent.requested";
        this.openPhase({
          kind: "agent",
          key: requiredPhaseKey("agent", subagentPhaseKey(event), event),
          message: queued ? `agent ${name} queued` : `agent ${name}`,
          priority: queued
            ? PHASE_PRIORITY.agentQueued
            : PHASE_PRIORITY.agentActive,
          depth: numberValue(meta.subagentDepth) ?? 0,
          startedSeq: eventSequence(event),
        });
        return;
      }
      case "subagent.completed":
      case "subagent.failed": {
        this.closePhase("agent", subagentPhaseKey(event));
        return;
      }
      case "run.completed":
      case "run.failed":
      case "run.cancelled": {
        this.openPhases.clear();
        this.modelRetries.clear();
        return;
      }
    }
  }

  private openPhase(phase: ActivePhase): void {
    this.openPhases.set(phase.key, phase);
  }

  private closePhase(kind: ActivePhaseKind, key: string | null): void {
    if (key && this.openPhases.delete(key)) return;
    this.closeLatestPhase(kind);
  }

  private closeAllPhases(kind: ActivePhaseKind): void {
    for (const [key, phase] of this.openPhases) {
      if (phase.kind === kind) this.openPhases.delete(key);
    }
  }

  private closeLatestPhase(kind: ActivePhaseKind): void {
    let latest: ActivePhase | null = null;
    for (const phase of this.openPhases.values()) {
      if (phase.kind !== kind) continue;
      if (!latest || phase.startedSeq > latest.startedSeq) latest = phase;
    }
    if (latest) this.openPhases.delete(latest.key);
  }

  private deriveActivePhase(): ActivePhase | null {
    let best: ActivePhase | null = null;
    for (const phase of this.openPhases.values()) {
      if (
        !best ||
        phase.priority > best.priority ||
        (phase.priority === best.priority && phase.depth > best.depth) ||
        (phase.priority === best.priority &&
          phase.depth === best.depth &&
          phase.startedSeq > best.startedSeq)
      ) {
        best = phase;
      }
    }
    return best;
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

function parsePendingHumanAction(value: unknown): PendingHumanAction | null {
  const action = rec(value);
  if (
    action.kind !== "skill_proposal_review" ||
    typeof action.proposalId !== "string" ||
    typeof action.reviewCommand !== "string" ||
    (action.eligibility !== "quick_apply" &&
      action.eligibility !== "review_required" &&
      action.eligibility !== "force_required") ||
    action.validationStatus !== "passed" ||
    (action.guardSeverity !== "none" &&
      action.guardSeverity !== "caution" &&
      action.guardSeverity !== "dangerous") ||
    (action.recommendedAction !== "apply" &&
      action.recommendedAction !== "review")
  ) {
    return null;
  }
  return {
    kind: "skill_proposal_review",
    proposalId: action.proposalId,
    reviewCommand: action.reviewCommand,
    eligibility: action.eligibility,
    validationStatus: "passed",
    ...(typeof action.contentMode === "string"
      ? { contentMode: action.contentMode }
      : {}),
    guardSeverity: action.guardSeverity,
    recommendedAction: action.recommendedAction,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function eventSequence(event: RunEvent): number {
  return typeof event.sequence === "number"
    ? event.sequence
    : Number.MAX_SAFE_INTEGER;
}

function eventField(event: RunEvent, key: string): unknown {
  return rec(event)[key];
}

function eventString(event: RunEvent, key: string): string | null {
  return firstString(eventField(event, key));
}

function requiredPhaseKey(
  kind: ActivePhaseKind,
  key: string | null,
  event: RunEvent,
): string {
  return (
    key ??
    `${kind}:event:${eventString(event, "id") ?? String(eventSequence(event))}`
  );
}

// Keyed by runId, not spanId: a run's model turns are sequential, and per-attempt
// events (model.requested, model.retrying) carry distinct span ids — keying by
// span would leave a turn-started/retry phase dangling when the next attempt's
// terminal event closes a different key. One model phase per run is correct.
function modelPhaseKey(event: RunEvent): string {
  const runId =
    eventString(event, "runId") ?? firstString(rec(event.payload).runId);
  if (runId) return `model:${runId}`;
  const spanId = eventString(event, "spanId");
  return `model:${spanId ?? "_"}`;
}

// Retry tally is keyed by runId, not spanId: every attempt in a turn shares the
// runId, but per-attempt model.requested events may carry distinct span ids.
function modelRetryKey(event: RunEvent): string {
  const runId =
    eventString(event, "runId") ?? firstString(rec(event.payload).runId);
  return runId ?? "_";
}

function compactionPhaseKey(event: RunEvent): string | null {
  const spanId = eventString(event, "spanId");
  if (spanId) return `compaction:${spanId}`;
  const runId =
    eventString(event, "runId") ?? firstString(rec(event.payload).runId);
  return runId ? `compaction:${runId}` : null;
}

function toolPhaseKey(event: RunEvent): string | null {
  const payload = rec(event.payload);
  const id = firstString(payload.id, payload.toolCallId, payload.callId);
  if (id) return `tool:${id}`;
  const spanId = eventString(event, "spanId");
  return spanId ? `tool:${spanId}` : null;
}

function subagentPhaseKey(event: RunEvent): string | null {
  const payload = rec(event.payload);
  const meta = rec(event.metadata);
  const childRunId = firstString(meta.childRunId, payload.childRunId);
  if (childRunId) return `agent:${childRunId}`;
  const spanId =
    eventString(event, "spanId") ?? firstString(meta.spanId, payload.spanId);
  return spanId ? `agent:${spanId}` : null;
}

function todoToolCallId(payload: Record<string, unknown>): string | null {
  const id = payload.id ?? payload.toolCallId ?? payload.callId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function parseTodoPanelItems(rawItems: unknown): TodoPanelItem[] | null {
  let items: unknown[] | null = null;
  if (Array.isArray(rawItems)) {
    items = rawItems;
  } else {
    const preview = rec(rawItems).preview;
    if (Array.isArray(preview)) items = preview;
  }
  if (!items) return null;
  return items.map((raw): TodoPanelItem => {
    const it = rec(raw);
    const title =
      (typeof it.title === "string" && it.title.trim()) || "(untitled)";
    return {
      title,
      status: typeof it.status === "string" ? it.status : "pending",
      depth:
        typeof it.depth === "number" && it.depth > 0 ? Math.floor(it.depth) : 0,
    };
  });
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
