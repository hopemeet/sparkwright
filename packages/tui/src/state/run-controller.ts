import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  createClient,
  type Client,
  type SpawnHostOptions,
} from "@sparkwright/sdk-node";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import type { EventStore } from "./event-store.js";
import type { SessionDiagnostics } from "../lib/sessions.js";
import { loadSessionEvents } from "../lib/session-events.js";
import { renderTranscript, type TranscriptHeader } from "../lib/transcript.js";
import type { RunEvent } from "../lib/event-type.js";

const require = createRequire(import.meta.url);

/**
 * Resolve the absolute path to the host bin packaged alongside us. We do
 * NOT import @sparkwright/host at module load — only its bin file, by
 * filesystem path — so the heavy core/openai deps it carries don't get
 * pulled into the TUI bundle until a run actually starts.
 */
function resolveHostBin(): string {
  return require.resolve("@sparkwright/host/dist/bin.js");
}

export type PermissionMode =
  | "plan"
  | "default"
  | "accept_edits"
  | "dont_ask"
  | "bypass_permissions";

export interface RunControllerOptions {
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  modelName?: string;
  store: EventStore;
  /** If provided, runs accumulate into this session id. */
  initialSessionId?: string;
}

type ApprovalDecision = "approved" | "denied";

/**
 * Drives runs against a Sparkwright host. The host is launched lazily on
 * first run (spawned child by default, or attached to SPARKWRIGHT_HOST_URL
 * when set — see @sparkwright/sdk-node).
 *
 * Each `start(goal)` issues a run.start request; all runs in a controller
 * lifetime share the same sessionId so the host accumulates events on disk
 * under `<workspace>/.sparkwright/sessions/<id>/`.
 *
 * /trace dumps the SDK's in-memory event log for the current run; the
 * host's on-disk trace is the canonical record but copying it via stdio
 * isn't worth a protocol round-trip just yet.
 */
export class RunController {
  private opts: RunControllerOptions;
  private store: EventStore;
  private sessionId: string;
  private client: Client | null = null;
  private clientPromise: Promise<Client> | null = null;
  private activeRunId: string | null = null;
  // Set once a cancel has been dispatched for the active run so a second Esc /
  // Ctrl+C (or both the InputBox and global-hotkey paths firing) doesn't send a
  // duplicate cancelRun. Reset when the next run starts.
  private cancelRequested = false;
  private currentSessionEvents: unknown[] = [];

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

  newSession(): string {
    this.sessionId = `session_tui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.currentSessionEvents = [];
    this.store.reset();
    this.store.setSessionId(this.sessionId);
    return this.sessionId;
  }

  setSession(id: string): void {
    this.sessionId = validateSessionId(id);
    this.currentSessionEvents = [];
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
    const events = await loadSessionEvents(this.opts.workspaceRoot, safe);
    this.currentSessionEvents = events.slice();
    this.replayEvents(events);
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
        this.store.appendUserMessage(payload.goal);
        injectedForRun.add(runKey);
      }
      if (STREAM_ONLY.has(ev.type)) continue;
      this.store.appendEvent(
        ev as unknown as Parameters<typeof this.store.appendEvent>[0],
      );
    }
  }

  /** Hot-swap the model. Affects the NEXT run; in-flight is unaffected. */
  updateModel(modelName?: string): void {
    this.opts.modelName = modelName;
  }

  updatePermissionMode(permissionMode: PermissionMode): void {
    this.opts.permissionMode = permissionMode;
  }

  isRunning(): boolean {
    return this.activeRunId !== null;
  }

  async start(goal: string): Promise<void> {
    if (this.activeRunId) return;
    let client: Client;
    try {
      client = await this.ensureClient();
    } catch (err) {
      this.store.setError(err instanceof Error ? err.message : String(err));
      return;
    }

    this.store.appendUserMessage(goal);
    this.store.setStatus("running");
    this.store.setStopReason(null);

    try {
      const { runId } = await client.startRun({
        goal,
        sessionId: this.sessionId,
        model: this.opts.modelName,
        permissionMode: this.opts.permissionMode,
      });
      this.activeRunId = runId;
      this.cancelRequested = false;
    } catch (err) {
      this.store.setError(formatError(err));
      this.activeRunId = null;
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
      const result = await client.listSessions({ limit: 20 });
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

  async inspectSession(sessionId: string): Promise<SessionDiagnostics | null> {
    try {
      const client = await this.ensureClient();
      const result = await client.inspectSession({ sessionId });
      return result as SessionDiagnostics;
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
    }
  }

  async inspectCapabilities(): Promise<CapabilitySnapshot | null> {
    try {
      const client = await this.ensureClient();
      return await client.inspectCapabilities();
    } catch (err) {
      this.store.setError(formatError(err));
      return null;
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

  async dumpTrace(): Promise<string> {
    const dir = join(this.opts.workspaceRoot, ".sparkwright", "tui-traces");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `trace-${this.sessionId}-${Date.now()}.jsonl`);
    const body = this.currentSessionEvents
      .map((e) => JSON.stringify(e))
      .join("\n");
    await writeFile(path, body + (body ? "\n" : ""), "utf8");
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

    const spawn: SpawnHostOptions = {
      command: process.execPath,
      args: [
        resolveHostBin(),
        "--stdio",
        "--workspace",
        this.opts.workspaceRoot,
        "--permission-mode",
        this.opts.permissionMode ?? "default",
        ...(this.opts.modelName ? ["--model", this.opts.modelName] : []),
      ],
    };
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

  private attachListeners(client: Client): void {
    client.on("run.event", (msg) => {
      // Pass through to the store. EventStore handles streaming chunk
      // assembly; we keep a parallel array for /trace dump.
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
        toolArgs: details.args ?? details.toolArgs,
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

    client.on("run.completed", (msg) => {
      this.activeRunId = null;
      this.store.setStopReason(msg.payload.stopReason ?? null);
      this.store.setStatus(
        msg.payload.stopReason === "manual_cancelled" ? "error" : "done",
      );
    });

    client.on("run.failed", (msg) => {
      this.activeRunId = null;
      this.store.setError(msg.payload.error.message);
    });

    client.on("disconnect", (reason) => {
      this.activeRunId = null;
      this.store.setError(`host disconnected${reason ? `: ${reason}` : ""}`);
      this.client = null;
      this.clientPromise = null;
    });

    // host.log events go unhandled in the TUI today — a future log panel
    // can subscribe via client.on('host.log', …).
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

function formatError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
