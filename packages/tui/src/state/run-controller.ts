import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient, type Client } from "@sparkwright/sdk-node";
import {
  buildImageRunInputPart,
  createHostCapabilityInspectRequest,
  createHostClientRunMetadata,
  createHostStartRunRequest,
  createRunInputPayloadFromParts,
  imageMediaTypeForPath,
  recordHostClientStartFailure,
  resolveHostClientApprovalByPolicy,
  resolveHostStdioSpawn,
  runInputMetadataRecord,
} from "@sparkwright/host";
import type {
  CapabilitySnapshot,
  CompactionWarning,
  PermissionMode,
  RunInputPayload,
  RunInputPart,
  SessionCompactionMeasurement,
  TaskListRequestPayload,
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
  TraceLevel,
  WorkflowListRequestPayload,
  WorkflowRunSnapshot,
} from "@sparkwright/protocol";
import { runFailureMessage } from "@sparkwright/protocol";
import type { EventStore } from "./event-store.js";
import type { SessionDiagnostics } from "../lib/sessions.js";
import { loadSessionEvents } from "../lib/session-events.js";
import { renderTranscript, type TranscriptHeader } from "../lib/transcript.js";
import type { RunEvent } from "../lib/event-type.js";
import {
  toCoreRunFields,
  type CoreRunPermissionFields,
  type TuiPermissionMode,
} from "../lib/permission.js";

export interface RunControllerOptions {
  workspaceRoot: string;
  /** Session/trace storage root. Defaults to <workspace>/.sparkwright/sessions. */
  sessionRootDir?: string;
  tuiPermissionMode?: TuiPermissionMode;
  traceLevel?: TraceLevel;
  /** Model reference shown by the TUI. Only request-sourced models are sent to the host. */
  modelName?: string;
  modelNameSource?: "config" | "request";
  store: EventStore;
  /** If provided, runs accumulate into this session id. */
  initialSessionId?: string;
}

export interface WorkflowJobHandle {
  runId: string;
  client: Client;
  close: () => void;
}

type ApprovalDecision = "approved" | "denied";

/**
 * Preamble of the synthetic goal a todo-supervisor continuation run carries
 * (see buildTodoContinuationPrompt in @sparkwright/agent-runtime). Used on
 * replay to tell a continuation run apart from a real user turn.
 */
const TODO_CONTINUATION_GOAL_PREFIX = "Continue from the todo ledger.";

/**
 * Drives runs against a Sparkwright host. The host is launched lazily on
 * first run (spawned child by default, or attached to SPARKWRIGHT_HOST_URL
 * when set — see @sparkwright/sdk-node).
 *
 * Each `start(goal)` issues a run.start request; all runs in a controller
 * lifetime share the same sessionId so the host accumulates events on disk
 * under `<workspace>/.sparkwright/sessions/<id>/`.
 *
 * Host on-disk session traces are the canonical record; this controller keeps
 * only the live event stream needed to render and export the current session.
 */
export class RunController {
  private opts: RunControllerOptions;
  private store: EventStore;
  private sessionId: string;
  private client: Client | null = null;
  private clientPromise: Promise<Client> | null = null;
  private activeRunId: string | null = null;
  private activeApprovalPermissionMode: PermissionMode | null = null;
  // Set once a cancel has been dispatched for the active run so a second Esc /
  // Ctrl+C (or both the InputBox and global-hotkey paths firing) doesn't send a
  // duplicate cancelRun. Reset when the next run starts.
  private cancelRequested = false;
  private currentSessionEvents: unknown[] = [];
  // The most recent user goal submitted via start(), kept so /retry can re-run
  // it. start() only ever receives real user goals (todo-continuation runs are
  // driven by the host/replay path, not start()), so no filtering is needed.
  private lastGoal: string | null = null;
  private pendingInputParts: RunInputPart[] = [];

  constructor(opts: RunControllerOptions) {
    this.opts = opts;
    this.store = opts.store;
    // Generate a session id eagerly so the header shows something stable
    // before the first run. The host honors whatever id we send.
    this.sessionId = opts.initialSessionId
      ? validateSessionId(opts.initialSessionId)
      : `session_tui_${Date.now().toString(36)}`;
    this.store.setSessionId(this.sessionId);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionRootDir(): string {
    return this.sessionRootDir();
  }

  newSession(): string {
    this.sessionId = `session_tui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.currentSessionEvents = [];
    this.lastGoal = null;
    this.store.reset();
    this.store.setSessionId(this.sessionId);
    return this.sessionId;
  }

  setSession(id: string): void {
    this.sessionId = validateSessionId(id);
    this.currentSessionEvents = [];
    this.lastGoal = null;
    this.store.reset();
    this.store.setSessionId(this.sessionId);
  }

  /**
   * Switch to an existing session AND repopulate the transcript from its
   * on-disk event log. `setSession` alone only swaps the id and wipes the
   * store, which left the screen blank — switching felt like a no-op because
   * the past session's history was never loaded. We read the persisted
   * `trace.jsonl`, drop the live-only streaming events (the committed
   * `model.completed` card already carries the final text), and replay the
   * rest so the conversation reappears.
   */
  async switchSession(id: string): Promise<void> {
    const safe = validateSessionId(id);
    this.sessionId = safe;
    this.store.reset();
    this.store.setSessionId(safe);
    const events = await loadSessionEvents(this.sessionRootDir(), safe);
    this.currentSessionEvents = events.slice();
    this.replayEvents(events);
    // Point /retry at the resumed session's most recent goal (not the goal
    // from whatever session we switched away from).
    this.lastGoal = lastGoalFromEvents(events);
  }

  /**
   * Replay a loaded event stream into the store. Synthesises the `tui.user`
   * goal cards (once per run id) the way `start()` does for live runs, since
   * the transcript renderer hides `run.created`/`run.started`. Skips the
   * `model.stream.*` events so the live-preview accumulator stays empty.
   */
  private replayEvents(events: RunEvent[]): void {
    const STREAM_ONLY = new Set([
      "model.stream.started",
      "model.stream.chunk",
      "model.stream.completed",
    ]);
    const injectedForRun = new Set<string>();
    for (const ev of events) {
      const payload = (ev.payload ?? {}) as { goal?: unknown };
      const runId = (ev as { runId?: unknown }).runId;
      const runKey = typeof runId === "string" ? runId : "";
      if (
        (ev.type === "run.created" || ev.type === "run.started") &&
        typeof payload.goal === "string" &&
        payload.goal.trim() &&
        !injectedForRun.has(runKey)
      ) {
        // A todo-supervisor continuation run carries a synthetic goal, not the
        // user's input. run.continuation is a host event (not in the persisted
        // trace), so on replay we detect the continuation by its goal preamble
        // and render a divider instead of a fake user bubble.
        if (payload.goal.startsWith(TODO_CONTINUATION_GOAL_PREFIX)) {
          this.store.appendNotice("continuing — todos unfinished");
        } else {
          this.store.appendUserMessage(payload.goal);
        }
        injectedForRun.add(runKey);
      }
      if (STREAM_ONLY.has(ev.type)) continue;
      this.store.appendEvent(
        ev as unknown as Parameters<typeof this.store.appendEvent>[0],
      );
    }
  }

  /** Hot-swap the model. Affects the NEXT run; in-flight is unaffected. */
  updateModel(
    modelName?: string,
    source: RunControllerOptions["modelNameSource"] = "request",
  ): void {
    this.opts.modelName = modelName;
    this.opts.modelNameSource = source;
  }

  updateTuiPermissionMode(tuiPermissionMode: TuiPermissionMode): void {
    this.opts.tuiPermissionMode = tuiPermissionMode;
  }

  updateTraceLevel(traceLevel: TraceLevel): void {
    this.opts.traceLevel = traceLevel;
  }

  isRunning(): boolean {
    return this.activeRunId !== null;
  }

  /** The last user goal, or null if nothing has been run yet (for /retry). */
  getLastGoal(): string | null {
    return this.lastGoal;
  }

  pendingAttachmentCount(): number {
    return this.pendingInputParts.length;
  }

  clearPendingAttachments(): void {
    this.pendingInputParts = [];
  }

  async attachImage(
    imagePath: string,
  ): Promise<
    { ok: true; name: string; count: number } | { ok: false; message: string }
  > {
    const trimmed = imagePath.trim();
    if (!trimmed) return { ok: false, message: "usage: /image <path>" };
    const resolved = resolve(this.opts.workspaceRoot, trimmed);
    if (!imageMediaTypeForPath(resolved)) {
      return {
        ok: false,
        message: "unsupported image type; use png, jpg, jpeg, gif, or webp",
      };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(resolved);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const imagePart = buildImageRunInputPart({
      sourcePath: trimmed,
      resolvedPath: resolved,
      bytes,
    });
    if (!imagePart.ok && imagePart.reason === "too_large") {
      return {
        ok: false,
        message: `image is too large (${imagePart.byteLength} bytes); limit is ${imagePart.maxBytes}`,
      };
    }
    if (!imagePart.ok) {
      return {
        ok: false,
        message: "unsupported image type; use png, jpg, jpeg, gif, or webp",
      };
    }
    const name = imagePart.part.name;
    this.pendingInputParts.push(imagePart.part);
    return { ok: true, name, count: this.pendingInputParts.length };
  }

  /**
   * Re-run the most recent goal in the same session. No-op (returns false) while
   * a run is active or before any goal has been submitted, so the caller can
   * surface a toast instead.
   */
  async retry(): Promise<boolean> {
    if (this.activeRunId || !this.lastGoal) return false;
    await this.start(this.lastGoal);
    return true;
  }

  async start(goal: string): Promise<void> {
    if (this.activeRunId) return;
    this.lastGoal = goal;
    this.store.appendUserMessage(goal);
    this.store.setStatus("running");
    this.store.setStopReason(null);

    let client: Client;
    try {
      client = await this.ensureClient();
    } catch (err) {
      const message = formatError(err);
      await this.recordHostStartFailure(goal, message);
      this.store.setError(message);
      return;
    }

    try {
      const traceLevel = this.opts.traceLevel ?? "standard";
      const input = this.pendingRunInput();
      const permissions = this.coreRunFields();
      this.activeApprovalPermissionMode = permissions.permissionMode;
      const { runId } = await client.startRun(
        createHostStartRunRequest({
          goal,
          input,
          sessionId: this.sessionId,
          modelName: this.opts.modelName,
          modelNameSource: this.opts.modelNameSource,
          accessMode: this.tuiPermissionMode(),
          permissionMode: permissions.permissionMode,
          traceLevel,
          shouldWrite: permissions.shouldWrite,
          metadata: this.runRequestMetadata({ traceLevel }),
        }),
      );
      this.activeRunId = runId;
      this.cancelRequested = false;
      if (input) this.clearPendingAttachments();
    } catch (err) {
      const message = formatError(err);
      if (!this.hasTerminalRunEvent()) {
        await this.recordHostStartFailure(goal, message);
      }
      this.store.setError(message);
      this.activeRunId = null;
      this.activeApprovalPermissionMode = null;
    }
  }

  cancel(): boolean {
    if (!this.activeRunId || !this.client) return false;
    if (this.cancelRequested) return false;
    this.cancelRequested = true;
    void this.client
      .cancelRun({ runId: this.activeRunId, reason: "tui esc" })
      .catch((err) => this.store.setError(formatError(err)));
    return true;
  }

  resolveApproval(decision: ApprovalDecision): void {
    const pending = this.store.getSnapshot().pendingApproval;
    if (!pending || !this.client) return;
    this.store.setPendingApproval(null);
    void this.client
      .resolveApproval({ approvalId: pending.id, decision })
      .catch((err) => this.store.setError(formatError(err)));
  }

  async listSessions(): Promise<
    Array<{ id: string; mtimeMs: number; preview: string }>
  > {
    try {
      const client = await this.ensureClient();
      const result = await client.listSessions({ limit: 200 });
      return result.sessions;
    } catch (err) {
      this.store.setError(formatError(err));
      return [];
    }
  }

  /**
   * Fork the given session at an optional event sequence. Returns the new
   * session id (and copy stats) or null on failure. Does NOT switch to it —
   * the caller decides whether to setSession(forkedId).
   */
  async forkSession(
    sourceSessionId: string,
    forkAtSequence?: number,
  ): Promise<{
    forkedSessionId: string;
    copiedEventCount: number;
    truncatedAtSequence: number | null;
  } | null> {
    try {
      const client = await this.ensureClient();
      return await client.forkSession({ sourceSessionId, forkAtSequence });
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
    }
  }

  async compactSession(): Promise<{
    compactedRunCount: number;
    throughRunId: string | null;
    originalCharCount: number;
    summaryCharCount: number;
    freedChars: number;
    measurement: SessionCompactionMeasurement;
    skippedReason?: string;
    warnings?: CompactionWarning[];
    artifactPath: string | null;
  } | null> {
    try {
      const client = await this.ensureClient();
      const result = await client.compactSession({
        sessionId: this.sessionId,
        reason: "tui /compact",
      });
      this.store.appendNotice(
        result.skippedReason
          ? `compact skipped: ${result.skippedReason}`
          : `compacted ${result.compactedRunCount} prior turn${result.compactedRunCount === 1 ? "" : "s"} for future context`,
      );
      return result;
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
    }
  }

  async inspectSession(sessionId: string): Promise<SessionDiagnostics | null> {
    try {
      const client = await this.ensureClient();
      const result = await client.inspectSession({
        sessionId,
        compaction: true,
      });
      return result as SessionDiagnostics;
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
    }
  }

  async inspectCapabilities(): Promise<CapabilitySnapshot | null> {
    try {
      const client = await this.ensureClient();
      return await client.inspectCapabilities(
        createHostCapabilityInspectRequest({
          sessionId: this.sessionId,
          modelName: this.opts.modelName,
          modelNameSource: this.opts.modelNameSource,
          accessMode: this.tuiPermissionMode(),
        }),
      );
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
    }
  }

  async listTasks(
    payload: TaskListRequestPayload = { limit: 50 },
  ): Promise<TaskRecordSnapshot[]> {
    try {
      const client = await this.ensureClient();
      const result = await client.listTasks(payload);
      return result.tasks;
    } catch (err) {
      this.store.setError(formatError(err));
      return [];
    }
  }

  async listWorkflowRuns(
    payload: WorkflowListRequestPayload = { limit: 100 },
  ): Promise<WorkflowRunSnapshot[]> {
    try {
      const client = await this.ensureClient();
      const result = await client.listWorkflowRuns(payload);
      return result.workflows;
    } catch (err) {
      this.store.setError(formatError(err));
      return [];
    }
  }

  async startWorkflowJob(input: {
    workflowName: string;
    goal: string;
  }): Promise<WorkflowJobHandle | null> {
    const client = await createClient({
      spawn: resolveHostStdioSpawn({
        workspaceRoot: this.opts.workspaceRoot,
        sessionRootDir: this.sessionRootDir(),
        permissionMode: this.coreRunFields().permissionMode,
      }),
      client: { name: "sparkwright-tui-workflow", version: "0.1.0" },
    });
    try {
      const traceLevel = this.opts.traceLevel ?? "standard";
      const permissions = this.coreRunFields();
      const { runId } = await client.startRun(
        createHostStartRunRequest({
          goal: input.goal,
          sessionId: this.sessionId,
          modelName: this.opts.modelName,
          modelNameSource: this.opts.modelNameSource,
          workflowName: input.workflowName,
          accessMode: this.tuiPermissionMode(),
          permissionMode: permissions.permissionMode,
          traceLevel,
          shouldWrite: permissions.shouldWrite,
          metadata: {
            ...this.runRequestMetadata({ traceLevel }),
            workflowStartSource: "tui",
          },
        }),
      );
      return {
        runId,
        client,
        close: () => client.close(),
      };
    } catch (err) {
      client.close();
      this.store.setError(formatError(err));
      return null;
    }
  }

  async readTaskOutput(
    taskId: string,
    maxChunks = 200,
  ): Promise<TaskOutputChunkSnapshot[]> {
    try {
      const client = await this.ensureClient();
      const result = await client.outputTask({ taskId, maxChunks });
      return result.chunks;
    } catch (err) {
      this.store.setError(formatError(err));
      return [];
    }
  }

  async stopTask(taskId: string): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const result = await client.stopTask({ taskId });
      return result.cancelled;
    } catch (err) {
      this.store.setError(formatError(err));
      return false;
    }
  }

  async joinTask(taskId: string): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const result = await client.joinTask({ taskId });
      return result.awaited;
    } catch (err) {
      this.store.setError(formatError(err));
      return false;
    }
  }

  async promoteTask(taskId: string): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const result = await client.promoteTask({ taskId });
      return result.promoted;
    } catch (err) {
      this.store.setError(formatError(err));
      return false;
    }
  }

  /**
   * Write a markdown transcript of the current session's in-memory events to
   * `<workspace>/.sparkwright/exports/session-<id>-<ts>.md`. Returns the path.
   * Doesn't touch the on-disk trace.jsonl (canonical, but not user-readable).
   */
  async exportTranscript(): Promise<string> {
    const dir = join(this.opts.workspaceRoot, ".sparkwright", "exports");
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = join(dir, `session-${this.sessionId}-${ts}.md`);
    const header: TranscriptHeader = {
      sessionId: this.sessionId,
      workspaceRoot: this.opts.workspaceRoot,
      model: this.opts.modelName,
    };
    const body = renderTranscript(
      header,
      this.currentSessionEvents as RunEvent[],
    );
    await writeFile(path, body, "utf8");
    return path;
  }

  /** Close the underlying client. Called on app exit. */
  shutdown(): void {
    this.client?.close();
    this.client = null;
    this.clientPromise = null;
  }

  // ----------------------------------------------------------------------

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.clientPromise) return this.clientPromise;

    const spawn = resolveHostStdioSpawn({
      workspaceRoot: this.opts.workspaceRoot,
      sessionRootDir: this.sessionRootDir(),
      permissionMode: this.coreRunFields().permissionMode,
    });
    this.clientPromise = createClient({
      spawn,
      client: { name: "sparkwright-tui", version: "0.1.0" },
    }).then((c) => {
      this.attachListeners(c);
      this.client = c;
      return c;
    });
    return this.clientPromise;
  }

  private sessionRootDir(): string {
    return (
      this.opts.sessionRootDir ??
      join(this.opts.workspaceRoot, ".sparkwright", "sessions")
    );
  }

  private async recordHostStartFailure(
    goal: string,
    message: string,
  ): Promise<void> {
    const result = await recordHostClientStartFailure({
      goal,
      message,
      sessionRootDir: this.sessionRootDir(),
      source: "tui",
      sessionId: this.sessionId,
      traceLevel: this.opts.traceLevel ?? "standard",
      shouldWrite: this.shouldWrite(),
      metadata: this.runRequestMetadata(),
    });
    if (!result.tracePath) return;
    try {
      const events = await loadSessionEvents(
        this.sessionRootDir(),
        this.sessionId,
      );
      const existingIds = new Set(
        this.currentSessionEvents
          .map((event) =>
            typeof event === "object" && event !== null && "id" in event
              ? (event as { id?: unknown }).id
              : undefined,
          )
          .filter((id): id is string => typeof id === "string"),
      );
      for (const event of events) {
        const id = typeof event.id === "string" ? event.id : undefined;
        if (id && existingIds.has(id)) continue;
        this.currentSessionEvents.push(event);
        if (id) existingIds.add(id);
        this.store.appendEvent(
          event as unknown as Parameters<typeof this.store.appendEvent>[0],
        );
      }
    } catch {
      // The UI already has the human-readable error. Trace readback is best
      // effort so a filesystem race cannot mask the original failure.
    }
  }

  private runRequestMetadata(
    input: { traceLevel?: TraceLevel } = {},
  ): Record<string, unknown> {
    const traceLevel = input.traceLevel ?? this.opts.traceLevel ?? "standard";
    const permissions = this.coreRunFields();
    return {
      ...createHostClientRunMetadata({
        source: "tui",
        sessionId: this.sessionId,
        workspaceRoot: this.opts.workspaceRoot,
        accessMode: this.tuiPermissionMode(),
        permissionMode: permissions.permissionMode,
        traceLevel,
        shouldWrite: permissions.shouldWrite,
        modelName: this.opts.modelName,
      }),
      ...runInputMetadataRecord(this.pendingRunInput()),
    };
  }

  private pendingRunInput(): RunInputPayload | undefined {
    if (this.pendingInputParts.length === 0) return undefined;
    return createRunInputPayloadFromParts(this.pendingInputParts);
  }

  private shouldWrite(): boolean {
    return this.coreRunFields().shouldWrite;
  }

  private tuiPermissionMode(): TuiPermissionMode {
    return this.opts.tuiPermissionMode ?? "ask";
  }

  private coreRunFields(): CoreRunPermissionFields {
    return toCoreRunFields(this.tuiPermissionMode());
  }

  private hasTerminalRunEvent(): boolean {
    return this.currentSessionEvents.some((event) => {
      if (typeof event !== "object" || event === null || !("type" in event)) {
        return false;
      }
      const type = (event as { type?: unknown }).type;
      return type === "run.failed" || type === "run.completed";
    });
  }

  private attachListeners(client: Client): void {
    client.on("run.event", (msg) => {
      // Pass through to the store. EventStore handles streaming chunk
      // assembly; we keep a parallel array for exports and replay checks.
      this.currentSessionEvents.push(msg.payload.event);
      // The host's SparkwrightEvent is opaque to the protocol layer
      // (`unknown`); the store's appendEvent expects the runtime shape.
      // Cast through unknown to satisfy the structural mismatch.
      this.store.appendEvent(
        msg.payload.event as unknown as Parameters<
          typeof this.store.appendEvent
        >[0],
      );
    });

    client.on("approval.requested", (msg) => {
      const details = (msg.payload.details ?? {}) as Record<string, unknown>;
      const action = msg.payload.action;
      const policyDecision = resolveHostClientApprovalByPolicy(
        this.approvalPolicyInput(),
        {
          approvalId: msg.payload.approvalId,
          runId: msg.payload.runId,
          action,
          summary: msg.payload.summary,
          details,
          createdAt: msg.timestamp,
        },
      );
      if (policyDecision) {
        void client
          .resolveApproval(policyDecision)
          .catch((err) => this.store.setError(formatError(err)));
        return;
      }
      const kind:
        | "workspace.write"
        | "tool.execute"
        | "shell.execute"
        | "other" =
        action === "workspace.write"
          ? "workspace.write"
          : action === "tool.execute"
            ? "tool.execute"
            : action === "shell.execute"
              ? "shell.execute"
              : "other";
      const pickString = (k: string): string | undefined =>
        typeof details[k] === "string" ? (details[k] as string) : undefined;
      const policyRaw = details.policy as
        | { decision?: string; reason?: string; metadata?: { risk?: string } }
        | undefined;
      this.store.setPendingApproval({
        id: msg.payload.approvalId,
        action,
        kind,
        summary: msg.payload.summary,
        path: pickString("path"),
        reason: pickString("reason"),
        diff: pickString("diff"),
        toolName: pickString("toolName") ?? pickString("name"),
        toolArgs: details.arguments ?? details.args ?? details.toolArgs,
        command: pickString("command"),
        policy: policyRaw
          ? {
              decision: policyRaw.decision,
              reason: policyRaw.reason,
              risk: policyRaw.metadata?.risk,
            }
          : undefined,
      });
    });

    client.on("run.continuation", (msg) => {
      // The todo supervisor superseded the prior run with a fresh one because
      // todos were still open. The turn is NOT over: re-point at the new runId
      // and keep "running" (the host suppresses the intermediate run.completed,
      // so no terminal arrives until the chain truly ends). Show a calm divider.
      this.activeRunId = msg.payload.runId;
      this.cancelRequested = false;
      this.store.setStatus("running");
      this.store.appendNotice(
        `continuing (#${msg.payload.continuationCount}) — todos unfinished`,
      );
    });

    client.on("run.completed", (msg) => {
      this.activeRunId = null;
      this.activeApprovalPermissionMode = null;
      this.store.setStopReason(msg.payload.stopReason ?? null);
      const handoff = msg.payload.todoHandoff;
      if (handoff) {
        // The chain stopped with todos still open (limit/stalled/non-resumable).
        // Surface it distinctly from a clean finish so the user knows work
        // remains and why it was handed back.
        this.store.appendNotice(`handed back: ${handoff.message}`);
        this.store.setStatus("done");
      } else {
        const terminalState = msg.payload.state;
        const userCancelled =
          msg.payload.stopReason === "manual_cancelled" ||
          msg.payload.stopReason === "user_cancelled";
        if (userCancelled) {
          this.store.setStatus("done");
        } else if (
          terminalState === "failed" ||
          terminalState === "cancelled"
        ) {
          this.store.setError(runFailureMessage(msg.payload));
        } else {
          this.store.setStatus("done");
        }
      }
    });

    client.on("run.failed", (msg) => {
      this.activeRunId = null;
      this.activeApprovalPermissionMode = null;
      this.store.setError(runFailureMessage(msg.payload));
    });

    client.on("disconnect", (reason) => {
      this.activeRunId = null;
      this.activeApprovalPermissionMode = null;
      this.store.setError(`host disconnected${reason ? `: ${reason}` : ""}`);
      this.client = null;
      this.clientPromise = null;
    });

    // host.log events go unhandled in the TUI today — a future log panel
    // can subscribe via client.on('host.log', …).
  }

  private approvalPolicyInput() {
    return {
      permissionMode:
        this.activeApprovalPermissionMode ??
        this.coreRunFields().permissionMode,
    };
  }
}

function validateSessionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    throw new Error("Session id must be a safe path segment.");
  }
  if (id === "." || id === ".." || id !== id.trim()) {
    throw new Error("Session id must be a safe path segment.");
  }
  return id;
}

/** The most recent goal carried by a loaded event stream, or null. */
function lastGoalFromEvents(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const goal = (events[i].payload as { goal?: unknown } | undefined)?.goal;
    if (typeof goal === "string" && goal.trim()) return goal;
  }
  return null;
}

function formatError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
