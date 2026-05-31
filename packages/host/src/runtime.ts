import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildTraceTimelineFile,
  asSessionId,
  createSessionId,
  createSessionRunStoreFactory,
  createPermissionModePolicy,
  createRun,
  FileSessionStore,
  forkSessionFromEvent,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  type ApprovalResolver,
  type ContextItem,
  type PermissionMode,
  type SparkwrightEvent,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  MemoryTrace,
} from "@sparkwright/core/internal";
import type {
  HostEvent,
  ProtocolError,
  RunStartRequestPayload,
} from "@sparkwright/protocol";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { nextMessageId, nowIso } from "./connection.js";
import { createModel } from "./model-factory.js";
import {
  createAppendFileTool,
  createCronTool,
  createGlobPathsTool,
  createReadFileTool,
} from "./tools.js";
import { createHostShellTool } from "./shell.js";

export interface RuntimeOptions {
  /** Workspace root for all runs spawned through this runtime. */
  workspaceRoot: string;
  /** Default model reference ("provider/model") when run.start omits one. */
  defaultModel?: string;
  /** Default permission mode when run.start does not specify one. */
  defaultPermissionMode?: PermissionMode;
  /** Called to deliver host events to the client. */
  emit: (event: HostEvent) => void;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  resolve: (decision: "approved" | "denied") => void;
}

interface ActiveRun {
  runId: string;
  run: ReturnType<typeof createRun>;
  trace: MemoryTrace;
  sessionId: string;
}

/**
 * Per-connection runtime. Maps protocol verbs onto core.createRun(),
 * threading events back out through `emit` as host events.
 *
 * A single connection runs at most one run at a time. Concurrent run.start
 * requests while another run is active reject with internal_error
 * (`run_already_active`); promoting to multiple parallel runs per
 * connection would be a v1.1 addition.
 */
export class HostRuntime {
  private opts: RuntimeOptions;
  private active: ActiveRun | null = null;
  // Synchronously-set reservation so two concurrent startRun() calls cannot
  // both pass the "is a run active?" guard before `this.active` is populated
  // (which only happens after `await createModel(...)`).
  private startingRun = false;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  hasActiveRun(): boolean {
    return this.active !== null;
  }

  /**
   * Start a new run. Returns the runId synchronously (after createRun
   * resolves) and continues streaming events asynchronously.
   */
  async startRun(
    payload: RunStartRequestPayload,
  ): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    if (this.active || this.startingRun) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    this.startingRun = true;
    try {
      return await this.startRunInner(payload);
    } finally {
      this.startingRun = false;
    }
  }

  private async startRunInner(
    payload: RunStartRequestPayload,
  ): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const modelRef = payload.model ?? this.opts.defaultModel;
    const permissionMode =
      payload.permissionMode ?? this.opts.defaultPermissionMode ?? "default";
    let sessionId: string;
    try {
      sessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
        : createSessionId();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const model = await createModel({
      modelRef,
      goal: payload.goal,
      workspaceRoot: this.opts.workspaceRoot,
    });
    if (!model.ok) {
      return {
        ok: false,
        error: { code: "invalid_payload", message: model.message },
      };
    }

    const workspace = new LocalWorkspace(this.opts.workspaceRoot);
    const workspaceRoot = this.opts.workspaceRoot;
    const sessionRootDir = join(workspaceRoot, ".sparkwright", "sessions");
    const trace = new MemoryTrace();

    // Captured by the approvalResolver closure so it always references the
    // run that created it, not whichever run happens to occupy `this.active`
    // at the moment the approval fires.
    const runIdHolder: { value: string | null } = { value: null };
    const approvalResolver: ApprovalResolver = (request) =>
      new Promise((resolve) => {
        const approvalId = request.id;
        const currentRunId = runIdHolder.value;
        if (!currentRunId) {
          // Approval requested before runId was populated — should not happen
          // because createRun returns synchronously, but guard rather than
          // crash on `null!`.
          resolve({ approvalId, decision: "denied" });
          return;
        }
        this.pendingApprovals.set(approvalId, {
          approvalId,
          runId: currentRunId,
          resolve: (decision) => resolve({ approvalId, decision }),
        });
        const details = request.details as { path?: unknown } | undefined;
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "approval.requested",
          timestamp: nowIso(),
          payload: {
            runId: currentRunId,
            approvalId,
            action: request.action,
            summary: request.summary,
            details: {
              ...(typeof details?.path === "string"
                ? { path: details.path }
                : {}),
              ...(request.details ?? {}),
            },
          },
        });
      });

    // Thread prior turns of this session into context so the model can see
    // the conversation history. Each completed prior run contributes a
    // user (goal) + assistant (final message) pair, tagged for the
    // "conversation" layer with session-stable cache policy.
    const priorContext = await this.loadConversationHistory(
      sessionRootDir,
      sessionId,
    );

    const run = createRun({
      goal: payload.goal,
      context: priorContext,
      workspace,
      approvalResolver,
      policy: createPermissionModePolicy({ mode: permissionMode }),
      promptBuilder: buildAgentPromptBuilder({ cwd: workspaceRoot, sessionId }),
      tools: [
        createReadFileTool(),
        createGlobPathsTool(workspaceRoot),
        createAppendFileTool(),
        createCronTool(),
        createHostShellTool(workspaceRoot),
      ],
      model: model.adapter,
      runStore: createSessionRunStoreFactory({
        sessionStore: new FileSessionStore({ rootDir: sessionRootDir }),
        sessionId,
        runStoreFactory: createSessionFileRunStoreFactory({
          sessionRootDir,
          sessionId,
          agentId: "main",
          traceLevel: "standard",
        }),
        metadata: {
          source: "host",
        },
      }),
    });

    const runId = run.record.id;
    runIdHolder.value = runId;
    this.active = { runId, run, trace, sessionId };

    // Subscribe to event stream and rebroadcast as host events.
    run.events.subscribe((event: SparkwrightEvent) => {
      trace.append(event);
      this.opts.emit({
        envelope: "event",
        id: nextMessageId("evt"),
        kind: "run.event",
        timestamp: nowIso(),
        payload: { runId, event },
      });
    });

    // Kick off the run lifecycle; do not await — the response goes back now,
    // events stream as they happen, terminal event lands later.
    void run
      .start()
      .then((result) => {
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.completed",
          timestamp: nowIso(),
          payload: {
            runId,
            state: result.state,
            stopReason: result.stopReason,
          },
        });
      })
      .catch((err: unknown) => {
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.failed",
          timestamp: nowIso(),
          payload: {
            runId,
            error: {
              code: "internal_error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      })
      .finally(() => {
        this.active = null;
        // Deny only this run's orphan approvals. The current per-connection
        // `startingRun` lock makes cross-run pollution impossible today, but
        // a future v1.1 with parallel runs per connection would silently
        // cancel siblings' pending decisions if we cleared the whole map.
        for (const [id, p] of this.pendingApprovals) {
          if (p.runId === runId) {
            p.resolve("denied");
            this.pendingApprovals.delete(id);
          }
        }
      });

    return { ok: true, runId };
  }

  /**
   * Build conversation-history context items from the prior runs of a session.
   * Each completed prior run contributes a user (goal) + assistant (final
   * message) pair, tagged for the "conversation" layer with session-stable
   * cache policy so the model sees the full multi-turn thread. New sessions
   * (no prior runs) yield an empty array. Missing/unreadable run files are
   * skipped rather than aborting the new run.
   */
  private async loadConversationHistory(
    sessionRootDir: string,
    sessionId: string,
  ): Promise<ContextItem[]> {
    let runIds: string[];
    try {
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      const session = await store.get(sessionId);
      runIds = session?.runIds ?? [];
    } catch {
      return [];
    }
    if (runIds.length === 0) return [];

    const runsDir = join(sessionRootDir, sessionId, "agents", "main", "runs");
    const items: ContextItem[] = [];
    for (const runId of runIds) {
      const goal = await this.readJsonField(
        join(runsDir, runId, "run.json"),
        "goal",
      );
      const message = await this.readJsonField(
        join(runsDir, runId, "result.json"),
        "message",
      );
      // A turn only counts toward history once it has both sides of the
      // exchange; a still-running or failed run with no final message is
      // skipped so we never thread a dangling half-turn.
      if (!goal || !message) continue;
      items.push({
        id: `ctx_${runId}_user` as ContextItem["id"],
        type: "user",
        content: goal.trim(),
        metadata: { layer: "conversation", stability: "session" },
      });
      items.push({
        id: `ctx_${runId}_assistant` as ContextItem["id"],
        type: "assistant",
        content: message.trim(),
        metadata: { layer: "conversation", stability: "session" },
      });
    }
    return items;
  }

  private async readJsonField(
    path: string,
    field: string,
  ): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      const value = parsed[field];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  cancelRun(
    runId: string,
    reason?: string,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (!this.active || this.active.runId !== runId) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `no active run with id ${runId}`,
        },
      };
    }
    this.active.run.cancel({ reason: reason ?? "client requested cancel" });
    return { ok: true };
  }

  injectRunMessage(
    runId: string,
    input: { content: string; metadata?: Record<string, unknown> },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (!this.active || this.active.runId !== runId) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `no active run with id ${runId}`,
        },
      };
    }
    if (!input.content.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "content must not be empty",
        },
      };
    }
    this.active.run.injectUserMessage({
      content: input.content,
      metadata: input.metadata,
    });
    return { ok: true };
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
  ): { ok: true } | { ok: false; error: ProtocolError } {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return {
        ok: false,
        error: {
          code: "approval_not_found",
          message: `no pending approval with id ${approvalId}`,
        },
      };
    }
    this.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
    return { ok: true };
  }

  /**
   * Called on disconnect: cancel active run + deny outstanding approvals so
   * core does not leak file handles or hang on never-arriving decisions.
   */
  cleanup(): void {
    for (const p of this.pendingApprovals.values()) p.resolve("denied");
    this.pendingApprovals.clear();
    if (this.active) {
      try {
        this.active.run.cancel({ reason: "client_disconnected" });
      } catch {
        // already cancelled
      }
      this.active = null;
    }
  }

  async listSessions(
    limit = 20,
  ): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
    const root = join(this.opts.workspaceRoot, ".sparkwright", "sessions");
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const results = await Promise.all(
      entries.map(async (id) => {
        const dir = join(root, id);
        try {
          const st = await stat(dir);
          if (!st.isDirectory()) return null;
          let preview = "";
          try {
            const transcript = await readFile(
              join(dir, "transcript.jsonl"),
              "utf8",
            );
            const firstLine = transcript.split("\n").find((l) => l.trim());
            if (firstLine) {
              try {
                const obj = JSON.parse(firstLine) as { content?: unknown };
                preview =
                  typeof obj.content === "string" ? obj.content : firstLine;
              } catch {
                preview = firstLine;
              }
            }
          } catch {
            // no transcript yet
          }
          return {
            id,
            mtimeMs: st.mtimeMs,
            preview: preview.slice(0, 80),
          };
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  }

  async inspectSession(sessionId: string): Promise<
    | {
        ok: true;
        sessionId: string;
        summary: Record<string, unknown>;
        consistency: Record<string, unknown>;
        timeline: Record<string, unknown>;
      }
    | { ok: false; error: ProtocolError }
  > {
    let safeSessionId: string;
    try {
      safeSessionId = asSessionId(sessionId);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sessionDir = join(
      this.opts.workspaceRoot,
      ".sparkwright",
      "sessions",
      safeSessionId,
    );
    try {
      const st = await stat(sessionDir);
      if (!st.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "session_not_found",
            message: `session not found: ${sessionId}`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "session_not_found",
          message: `session not found: ${sessionId}`,
        },
      };
    }

    try {
      const tracePath = join(sessionDir, "trace.jsonl");
      const [summary, consistency, timeline] = await Promise.all([
        summarizeTraceFile(tracePath),
        validateSessionTraceConsistency({ sessionDir }),
        buildTraceTimelineFile(tracePath),
      ]);
      return {
        ok: true,
        sessionId: safeSessionId,
        summary: summary as unknown as Record<string, unknown>,
        consistency: consistency as unknown as Record<string, unknown>,
        timeline: timeline as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Fork a session at an optional event sequence into a brand-new session,
   * using core's forkSessionFromEvent over the file-backed session store.
   * The new session's run references are copied; subsequent runs extend the
   * fork rather than the original.
   */
  async forkSession(
    sourceSessionId: string,
    forkAtSequence?: number,
  ): Promise<
    | {
        ok: true;
        forkedSessionId: string;
        copiedEventCount: number;
        truncatedAtSequence: number | null;
      }
    | { ok: false; error: ProtocolError }
  > {
    let safeSource: string;
    try {
      safeSource = asSessionId(sourceSessionId);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sessionRootDir = join(
      this.opts.workspaceRoot,
      ".sparkwright",
      "sessions",
    );
    try {
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      const result = await forkSessionFromEvent({
        sourceSessionId: safeSource,
        forkAtSequence,
        store,
        metadata: { forkedVia: "tui" },
      });
      return {
        ok: true,
        forkedSessionId: result.forked.id,
        copiedEventCount: result.copiedEventCount,
        truncatedAtSequence: result.truncatedAtSequence,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
