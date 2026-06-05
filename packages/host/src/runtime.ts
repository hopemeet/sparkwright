import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildTraceTimelineFile,
  asSessionId,
  createBufferedEmitter,
  createSessionId,
  createSessionRunStoreFactory,
  createPermissionModePolicy,
  createRun,
  defineTool,
  FileSessionStore,
  forkSessionFromEvent,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  type ApprovalResolver,
  type ContextItem,
  type EventEmitter,
  type ModelAdapter,
  type PermissionMode,
  type SparkwrightEvent,
  type ToolDefinition,
  type ToolOrigin,
} from "@sparkwright/core";
import {
  prepareSkillsForRun,
  type LoadedSkill,
  type SkillIndexEntry,
} from "@sparkwright/skills";
import {
  prepareMcpToolsForRun,
  type McpStatus,
  type McpToolNameMapping,
} from "@sparkwright/mcp-adapter";
import {
  createAgentTool,
  deriveChildAgentProfile,
  spawnSubAgent,
  type AgentProfile,
  type DerivedChildAgentProfile,
} from "@sparkwright/agent-runtime";
import type { CapabilityDelegateToolConfig } from "./config.js";
import {
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  MemoryTrace,
} from "@sparkwright/core/internal";
import type {
  HostEvent,
  ProtocolError,
  RunStartRequestPayload,
  CapabilitySnapshot,
} from "@sparkwright/protocol";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { loadHostConfig } from "./config.js";
import { resolveAgentProfiles } from "./agent-profiles.js";
import { nextMessageId, nowIso } from "./connection.js";
import { createModel } from "./model-factory.js";
import {
  createAppendFileTool,
  createCronTool,
  createAgentInspectorTool,
  createAgentManagerTool,
  createGlobPathsTool,
  createGrepTextTool,
  applyToolConfig,
  createReadFileTool,
  createSkillInspectorTool,
  createSkillManagerTool,
} from "./tools.js";
import { createHostShellTool } from "./shell.js";

/**
 * Skills flagged `metadata.devOnly: true` (test/development fixtures) are kept
 * out of run candidate sets unless `SPARKWRIGHT_DEV_SKILLS` is explicitly
 * enabled. This stops smoke-test skills from mis-triggering in real sessions.
 */
function devSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SPARKWRIGHT_DEV_SKILLS;
  return value === "1" || value === "true";
}

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
  closeCapabilities?: () => Promise<void>;
}

const MAIN_AGENT_ID = "main";

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
  private lastCapabilitySnapshot: CapabilitySnapshot | null = null;

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  hasActiveRun(): boolean {
    return this.active !== null;
  }

  async inspectCapabilities(): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    try {
      const configured = await this.inspectConfiguredCapabilities();
      return {
        ok: true,
        snapshot: mergeCapabilitySnapshots(
          configured,
          this.lastCapabilitySnapshot,
        ),
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
    const pendingExtensionEvents = createBufferedEmitter();

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
    const loadedConfig = await loadHostConfig(workspaceRoot);
    const toolConfig = loadedConfig.config.capabilities?.tools;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const mcpConfig = loadedConfig.config.capabilities?.mcp;
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const preparedSkills = skillConfig?.roots?.length
      ? await prepareSkillsForRun({
          goal: payload.goal,
          skillRoots: skillConfig.roots,
          agent: {
            allowedSkills: skillConfig.allowedSkills,
            deniedSkills: skillConfig.deniedSkills,
          },
          // Default to on-demand loading: expose the skill.load tool and let
          // the model pull bodies it judges relevant, rather than auto-residing
          // matcher-selected skills (which both pollutes context and double-
          // injects when the loader tool is also on). A config can opt back into
          // auto-resident by setting loadSelectedSkills: true.
          includeLoaderTool: skillConfig.includeLoaderTool ?? true,
          loadSelectedSkills: skillConfig.loadSelectedSkills ?? false,
          maxSelectedSkills: skillConfig.maxSelectedSkills,
          resourceFileLimit: skillConfig.resourceFileLimit,
          includeDevSkills: devSkillsEnabled(),
          emitter: pendingExtensionEvents,
          agentId: MAIN_AGENT_ID,
        })
      : null;
    const preparedMcp = mcpConfig?.servers?.length
      ? await prepareMcpToolsForRun({
          servers: mcpConfig.servers,
          defaultTimeoutMs: mcpConfig.defaultTimeoutMs,
          namePrefix: mcpConfig.namePrefix,
          policy: mcpConfig.defaultPolicy,
          emitter: pendingExtensionEvents,
          agentId: MAIN_AGENT_ID,
        })
      : null;
    // Fold markdown-authored agents under config profiles (config wins by id),
    // so .sparkwright/agents/*.md and config.json describe the same agent set.
    const resolvedProfiles = await resolveAgentProfiles(
      workspaceRoot,
      agentConfig?.profiles,
    );
    const mainAgent = mainAgentProfile(resolvedProfiles);
    const derivedAgents = deriveConfiguredAgents(
      mainAgent,
      resolvedProfiles,
      pendingExtensionEvents,
    );
    const parentRunRef: { current?: ReturnType<typeof createRun> } = {};
    // Shared across the parent run and every spawned sub-agent so child runs
    // persist into the SAME session (registering under `session.json.agents`)
    // instead of vanishing, and so writes to session.json don't race.
    const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
    const childRunStoreFactory = (childAgentId: string) =>
      createSessionRunStoreFactory({
        sessionStore,
        sessionId,
        runStoreFactory: createSessionFileRunStoreFactory({
          sessionRootDir,
          sessionId,
          agentId: childAgentId,
          traceLevel: "standard",
        }),
        metadata: { source: "host" },
      });
    const baseChildTools = [
      createReadFileTool(),
      createGlobPathsTool(workspaceRoot),
      createGrepTextTool(workspaceRoot),
    ];
    const childTools = applyToolConfig(baseChildTools, toolConfig);
    const delegateTools = createConfiguredDelegateTools({
      getParent: () => parentRunRef.current,
      delegates: agentConfig?.delegateTools ?? [],
      derivedAgents,
      model: model.adapter,
      childTools,
      childRunStoreFactory,
    });
    const dynamicSpawnTool = createDynamicSpawnAgentTool({
      getParent: () => parentRunRef.current,
      model: model.adapter,
      childTools,
      childRunStoreFactory,
    });
    const tools = applyToolConfig(
      [
        createReadFileTool(),
        createGlobPathsTool(workspaceRoot),
        createGrepTextTool(workspaceRoot),
        createAppendFileTool(),
        createCronTool(),
        createSkillInspectorTool(workspaceRoot, skillConfig?.roots),
        createSkillManagerTool(workspaceRoot, skillConfig?.roots),
        createAgentInspectorTool(workspaceRoot),
        createAgentManagerTool(workspaceRoot),
        createHostShellTool(workspaceRoot),
        ...(preparedSkills?.tools ?? []),
        ...(preparedMcp?.tools ?? []),
        ...delegateTools,
        dynamicSpawnTool,
      ],
      toolConfig,
    );
    this.lastCapabilitySnapshot = buildCapabilitySnapshot({
      tools,
      indexedSkills: preparedSkills?.indexedSkills ?? [],
      loadedSkills: preparedSkills?.loadedSkills ?? [],
      mcpStatuses: preparedMcp?.statuses ?? {},
      mcpToolNameMap: preparedMcp?.toolNameMap ?? [],
      agentProfiles: [
        mainAgent,
        ...derivedAgents.map((agent) => agent.effectiveProfile),
      ],
    });

    const run = createRun({
      goal: payload.goal,
      context: [...priorContext, ...(preparedSkills?.context ?? [])],
      workspace,
      approvalResolver,
      policy: createPermissionModePolicy({ mode: permissionMode }),
      promptBuilder: buildAgentPromptBuilder({ cwd: workspaceRoot, sessionId }),
      tools,
      model: model.adapter,
      // Bind the main agent on resources, not a leaked step count of 8: honor
      // the profile's RunBudget when set and derive the step ceiling from it.
      maxSteps: resolveMainAgentMaxSteps(mainAgent),
      ...(mainAgent.runBudget !== undefined
        ? { runBudget: mainAgent.runBudget }
        : {}),
      runStore: createSessionRunStoreFactory({
        sessionStore,
        sessionId,
        runStoreFactory: createSessionFileRunStoreFactory({
          sessionRootDir,
          sessionId,
          agentId: "main",
          traceLevel: "standard",
        }),
        metadata: {
          source: "host",
          ...(preparedSkills
            ? {
                indexedSkills: preparedSkills.indexedSkills,
                loadedSkills: preparedSkills.loadedSkills,
              }
            : {}),
          ...(preparedMcp
            ? {
                mcpStatuses: preparedMcp.statuses,
                mcpToolNameMap: preparedMcp.toolNameMap,
              }
            : {}),
          ...(resolvedProfiles.length
            ? {
                agentProfiles: [
                  mainAgent,
                  ...derivedAgents.map((agent) => agent.effectiveProfile),
                ],
              }
            : {}),
        },
      }),
    });
    parentRunRef.current = run;

    const runId = run.record.id;
    runIdHolder.value = runId;
    this.active = {
      runId,
      run,
      trace,
      sessionId,
      closeCapabilities: preparedMcp ? () => preparedMcp.close() : undefined,
    };

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
    pendingExtensionEvents.flush(run.events);

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
        void preparedMcp?.close().catch(() => {});
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

  private async inspectConfiguredCapabilities(): Promise<CapabilitySnapshot> {
    const loadedConfig = await loadHostConfig(this.opts.workspaceRoot);
    const toolConfig = loadedConfig.config.capabilities?.tools;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const mcpConfig = loadedConfig.config.capabilities?.mcp;
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const resolvedProfiles = await resolveAgentProfiles(
      this.opts.workspaceRoot,
      agentConfig?.profiles,
    );
    const preparedSkills =
      skillConfig?.roots?.length && skillConfig.roots.length > 0
        ? await prepareSkillsForRun({
            goal: "",
            skillRoots: skillConfig.roots,
            agent: {
              allowedSkills: skillConfig.allowedSkills,
              deniedSkills: skillConfig.deniedSkills,
            },
            includeLoaderTool: skillConfig.includeLoaderTool ?? true,
            loadSelectedSkills: false,
            resourceFileLimit: skillConfig.resourceFileLimit,
            includeDevSkills: devSkillsEnabled(),
            agentId: MAIN_AGENT_ID,
          })
        : null;
    return buildCapabilitySnapshot({
      tools: applyToolConfig(
        [
          createReadFileTool(),
          createGlobPathsTool(this.opts.workspaceRoot),
          createGrepTextTool(this.opts.workspaceRoot),
          createAppendFileTool(),
          createCronTool(),
          createSkillInspectorTool(this.opts.workspaceRoot, skillConfig?.roots),
          createSkillManagerTool(this.opts.workspaceRoot, skillConfig?.roots),
          createAgentInspectorTool(this.opts.workspaceRoot),
          createAgentManagerTool(this.opts.workspaceRoot),
          createHostShellTool(this.opts.workspaceRoot),
          ...(preparedSkills?.tools ?? []),
          ...createConfiguredDelegateTools({
            getParent: () => undefined,
            delegates: agentConfig?.delegateTools ?? [],
            derivedAgents: deriveConfiguredAgents(
              mainAgentProfile(resolvedProfiles),
              resolvedProfiles,
            ),
            model: {
              async complete() {
                return { message: "" };
              },
            },
            childTools: [
              createReadFileTool(),
              createGlobPathsTool(this.opts.workspaceRoot),
              createGrepTextTool(this.opts.workspaceRoot),
            ],
            // Snapshot only describes the tool; its body never runs here
            // (getParent returns undefined and the tool throws first).
            childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
          }),
          createDynamicSpawnAgentTool({
            getParent: () => undefined,
            model: {
              async complete() {
                return { message: "" };
              },
            },
            childTools: applyToolConfig(
              [
                createReadFileTool(),
                createGlobPathsTool(this.opts.workspaceRoot),
                createGrepTextTool(this.opts.workspaceRoot),
              ],
              toolConfig,
            ),
            childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
          }),
        ],
        toolConfig,
      ),
      indexedSkills: preparedSkills?.indexedSkills ?? [],
      loadedSkills: [],
      mcpStatuses: Object.fromEntries(
        (mcpConfig?.servers ?? []).map((server) => [
          server.name,
          server.enabled === false
            ? ({ status: "disabled" } as const)
            : ({ status: "configured" } as const),
        ]),
      ),
      mcpToolNameMap: [],
      agentProfiles: [
        mainAgentProfile(resolvedProfiles),
        ...deriveConfiguredAgents(
          mainAgentProfile(resolvedProfiles),
          resolvedProfiles,
        ).map((agent) => agent.effectiveProfile),
      ],
    });
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
        void this.active.closeCapabilities?.().catch(() => {});
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

function buildCapabilitySnapshot(input: {
  tools: ToolDefinition[];
  indexedSkills: SkillIndexEntry[];
  loadedSkills: LoadedSkill[];
  mcpStatuses?: Record<string, McpStatus | { status: "configured" }>;
  mcpToolNameMap?: McpToolNameMapping[];
  agentProfiles?: AgentProfile[];
}): CapabilitySnapshot {
  return {
    tools: input.tools.map((tool) => ({
      name: tool.name,
      origin: formatToolOrigin(tool.governance?.origin),
      risk: tool.policy?.risk,
    })),
    skills: {
      indexed: input.indexedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        version: skill.version,
      })),
      loaded: input.loadedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        version: skill.version,
        selectionReason: skill.selectionReason,
      })),
    },
    mcp: {
      statuses: Object.entries(input.mcpStatuses ?? {}).map(
        ([serverName, status]) => ({
          serverName,
          status: status.status,
          toolNames: (input.mcpToolNameMap ?? [])
            .filter((mapping) => mapping.serverName === serverName)
            .map((mapping) => mapping.toolName),
        }),
      ),
    },
    agents: {
      profiles: (
        input.agentProfiles ?? [{ id: MAIN_AGENT_ID, mode: "primary" }]
      ).map((profile) => ({
        id: profile.id,
        name: profile.name,
        mode: profile.experimental?.mode ?? profile.mode,
      })),
    },
  };
}

function mainAgentProfile(profiles: AgentProfile[] | undefined): AgentProfile {
  return (
    profiles?.find(
      (profile) =>
        profile.id === MAIN_AGENT_ID ||
        profile.experimental?.mode === "primary" ||
        profile.mode === "primary",
    ) ?? { id: MAIN_AGENT_ID, mode: "primary" }
  );
}

/**
 * Pure safety floor for the interactive main agent's step count, used only when
 * neither an explicit `maxSteps` nor a model-call budget is configured. It is a
 * backstop against a runaway loop the progress guard misses (the human can also
 * Ctrl-C), NOT a task budget — long-horizon work (auto-research, broad sweeps)
 * must not bind on it. See `docs/adr/0009-step-cap-unfit-for-long-horizon-agents.md`.
 */
const MAIN_AGENT_MAX_STEPS_BACKSTOP = 100;

/**
 * Resolve the main agent's step ceiling. An explicit profile `maxSteps` wins;
 * otherwise it is derived from the resource budget — a step consumes at least
 * one model call, so `runBudget.maxModelCalls` is the tightest natural step
 * bound and `RunBudget` enforces it precisely regardless. Only when neither is
 * configured does the high backstop apply. This keeps the binding limit on the
 * resource axis rather than a leaked step count of 8.
 */
function resolveMainAgentMaxSteps(profile: AgentProfile): number {
  if (profile.maxSteps !== undefined) return profile.maxSteps;
  const modelCallBudget = profile.runBudget?.maxModelCalls;
  if (modelCallBudget !== undefined && modelCallBudget >= 1) {
    return modelCallBudget;
  }
  return MAIN_AGENT_MAX_STEPS_BACKSTOP;
}

function deriveConfiguredAgents(
  parentAgent: AgentProfile,
  profiles: AgentProfile[],
  emitter?: EventEmitter,
): DerivedChildAgentProfile[] {
  return profiles
    .filter((profile) => profile.id !== parentAgent.id)
    .filter((profile) => {
      const mode = profile.experimental?.mode ?? profile.mode;
      return mode === undefined || mode === "child" || mode === "all";
    })
    .map((childAgent) =>
      deriveChildAgentProfile({
        parentAgent,
        childAgent,
        emitter,
      }),
    );
}

/**
 * Placeholder `childRunStoreFactory` for the capability-snapshot path, where
 * tools are only described (never invoked). If a snapshot-built spawn tool were
 * ever executed it would throw on missing parent first; this guards the
 * unreachable case loudly rather than silently dropping a child trace.
 */
const snapshotOnlyChildRunStoreFactory = (): ReturnType<
  typeof createSessionRunStoreFactory
> => {
  throw new Error(
    "spawn tool built for a capability snapshot cannot be executed.",
  );
};

function createConfiguredDelegateTools(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  model: ModelAdapter;
  childTools: ToolDefinition[];
  /** Builds a session-scoped run store for the child, keyed by its agent id. */
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition[] {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const tools: ToolDefinition[] = [];
  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName =
      delegate.toolName ??
      `delegate_${sanitizeToolSegment(delegate.profileId)}`;
    tools.push(
      createAgentTool(input.getParent, {
        name: toolName,
        description:
          delegate.description ??
          `Delegate a bounded task to ${profile.name ?? profile.id}.`,
        requiresApproval: delegate.requiresApproval,
        forbidNesting: delegate.forbidNesting ?? true,
        buildSpawnInput: (args, parent) => ({
          goal: args.goal,
          model: input.model,
          tools: input.childTools,
          childAgentProfile: profile,
          maxSteps: delegate.maxSteps ?? profile.maxSteps,
          runBudget: profile.runBudget,
          // Persist the child's trace under its own agent dir + register it in
          // session.json, and roll its usage up into the parent run's tracker.
          runStore: input.childRunStoreFactory(profile.id),
          parentUsageTracker: parent.getUsageTracker(),
          metadata: {
            ...(args.metadata ?? {}),
            agentId: profile.id,
            agentProfileId: profile.id,
            agentName: profile.name,
          },
        }),
      }),
    );
  }
  return tools;
}

/**
 * @internal Exported for host regression tests that assert the spawn path
 * threads `runStore` + `parentUsageTracker` into the child run. Not part of the
 * public host API.
 */
export function createDynamicSpawnAgentTool(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  model: ModelAdapter;
  childTools: ToolDefinition[];
  /** Builds a session-scoped run store for the child, keyed by its agent id. */
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition {
  return defineTool({
    name: "spawn_agent",
    description:
      "Spawn a bounded, read-only child agent for one focused sub-task. The child may inspect files but cannot write, run shell commands, or spawn further agents. Use this for temporary roles; if the same role becomes useful repeatedly, create a stable profile with manage_agent and delegate to it through a delegate_* tool.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The concrete sub-task the child agent should complete.",
        },
        role: {
          type: "string",
          description: "Short role name for the child agent.",
        },
        prompt: {
          type: "string",
          description:
            "Focused instructions that define the child agent's scope and output.",
        },
        allowedTools: {
          type: "array",
          description:
            "Optional subset of read-only tools to expose. Supported: read_file, glob_paths, grep_text. Defaults to all three. Use grep_text to find a symbol by name (glob_paths only matches paths, not contents).",
          items: {
            type: "string",
            enum: ["read_file", "glob_paths", "grep_text"],
          },
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "Optional child step (model turn) limit; allocate by sub-task complexity. Defaults to 8 when omitted, capped at 16. A multi-step search (glob, read, refine, conclude) typically needs 6+.",
        },
        metadata: {
          type: "object",
          description: "Optional structured metadata for the child run.",
        },
      },
      required: ["goal", "role", "prompt"],
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "conditional",
    },
    isReplaySafe: false,
    async execute(args: unknown): Promise<unknown> {
      const parent = input.getParent();
      if (!parent) {
        throw new Error(
          'Tool "spawn_agent" was invoked but no parent RunHandle is available.',
        );
      }
      if (typeof parent.record.metadata?.parentRunId === "string") {
        throw new Error(
          'Tool "spawn_agent" refused to nest: parent run is itself a sub-agent.',
        );
      }

      const parsed = parseDynamicSpawnAgentArgs(args);
      const supportedTools = new Set(["read_file", "glob_paths", "grep_text"]);
      const requestedTools = parsed.allowedTools ?? [
        "read_file",
        "glob_paths",
        "grep_text",
      ];
      const availableTools = new Map(
        input.childTools.map((tool) => [tool.name, tool]),
      );
      const invalidTools = requestedTools.filter(
        (name) => !supportedTools.has(name) || !availableTools.has(name),
      );
      if (invalidTools.length > 0) {
        throw new Error(
          `spawn_agent only supports enabled read-only child tools: ${invalidTools.join(
            ", ",
          )}`,
        );
      }
      const childTools = requestedTools
        .map((name) => availableTools.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined);
      if (childTools.length === 0) {
        throw new Error(
          "spawn_agent requires at least one enabled child tool.",
        );
      }

      // Strip any leading `dynamic_` the role already carries so a re-used
      // agent id (models sometimes pass a prior child's `dynamic_<role>` id
      // back in as the new role) does not compound into `dynamic_dynamic_*`.
      const roleSegment = sanitizeToolSegment(parsed.role).replace(
        /^(?:dynamic_)+/,
        "",
      );
      const agentId = `dynamic_${roleSegment || "agent"}`;
      const profile: AgentProfile = {
        id: agentId,
        name: parsed.role,
        mode: "child",
        allowedTools: childTools.map((tool) => tool.name),
        maxSteps: parsed.maxSteps,
        experimental: {
          mode: "child",
          prompt: parsed.prompt,
        },
        metadata: {
          dynamic: true,
        },
      };
      const spawned = spawnSubAgent({
        parent,
        goal: parsed.goal,
        model: input.model,
        tools: childTools,
        childAgentProfile: profile,
        maxSteps: parsed.maxSteps,
        // Persist the child's own trace/transcript under
        // `sessions/<id>/agents/<agentId>/` and register it in session.json,
        // instead of letting its steps disappear once the tool returns.
        runStore: input.childRunStoreFactory(agentId),
        // Fold the child's tool/model usage into the parent run's tracker so
        // session usage totals (and the live `usage.updated` stream) reflect
        // sub-agent spend rather than under-reporting it.
        parentUsageTracker: parent.getUsageTracker(),
        metadata: {
          ...(parsed.metadata ?? {}),
          dynamic: true,
          agentId,
          agentProfileId: agentId,
          agentName: parsed.role,
          allowedTools: childTools.map((tool) => tool.name),
        },
      });
      const result = await spawned.run.start();
      const usage = spawned.run.usage();
      // A child that answered on its last allowed step may have wrapped up early
      // under the step budget; tell the parent so it can caveat rather than
      // present a possibly-truncated child answer as exhaustive.
      const stepLimitReached =
        (result.metadata as { stepLimitReached?: unknown } | undefined)
          ?.stepLimitReached === true;
      // A child that failed (doom-loop, step-limit, error) never emitted a final
      // answer, so salvage its most recent successful tool results — otherwise
      // the parent only sees an error string and must re-spawn to rediscover the
      // same data. Success carries the answer in `message`, so skip it there.
      const partialObservations =
        result.signal === "completed"
          ? undefined
          : extractPartialObservations(spawned.run.events.all(), 3);
      const output = {
        childRunId: spawned.childRunId,
        spanId: spawned.spanId,
        agentId,
        role: parsed.role,
        signal: result.signal,
        stopReason: result.stopReason,
        stepLimitReached,
        message: result.message,
        ...(partialObservations && partialObservations.length > 0
          ? { partialObservations }
          : {}),
        usage,
        promotionHint: {
          action: "manage_agent.create",
          reason:
            "If this temporary role is useful repeatedly, create a stable agent profile and delegate tool instead of continuing to spawn it ad hoc.",
          suggestedProfile: {
            id: sanitizeToolSegment(parsed.role),
            name: parsed.role,
            mode: "child",
            prompt: parsed.prompt,
            allowedTools: childTools.map((tool) => tool.name),
            maxSteps: parsed.maxSteps,
            delegateToolName: `delegate_${sanitizeToolSegment(parsed.role)}`,
          },
        },
      };
      if (result.signal !== "completed") {
        throw new Error(
          `spawn_agent child run did not complete: ${JSON.stringify(output)}`,
        );
      }
      return output;
    },
  });
}

function parseDynamicSpawnAgentArgs(args: unknown): {
  goal: string;
  role: string;
  prompt: string;
  allowedTools?: string[];
  maxSteps: number;
  metadata?: Record<string, unknown>;
} {
  if (!args || typeof args !== "object") {
    throw new Error("spawn_agent expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const goal = stringField(record, "goal");
  const role = stringField(record, "role");
  const prompt = stringField(record, "prompt");
  const allowedTools = Array.isArray(record.allowedTools)
    ? record.allowedTools.map((value) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error("spawn_agent allowedTools must contain strings.");
        }
        return value.trim();
      })
    : undefined;
  if (allowedTools && new Set(allowedTools).size !== allowedTools.length) {
    throw new Error("spawn_agent allowedTools must not contain duplicates.");
  }
  const maxSteps =
    record.maxSteps === undefined ? 8 : integerField(record, "maxSteps");
  if (maxSteps < 1) {
    throw new Error("spawn_agent maxSteps must be at least 1.");
  }
  const metadata =
    record.metadata === undefined ? undefined : objectField(record, "metadata");
  return {
    goal,
    role,
    prompt,
    allowedTools,
    maxSteps: Math.min(maxSteps, 16),
    metadata,
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`spawn_agent ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value)) {
    throw new Error(`spawn_agent ${field} must be an integer.`);
  }
  return value as number;
}

function objectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`spawn_agent ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function sanitizeToolSegment(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return clean.replace(/^_+|_+$/g, "") || "agent";
}

/** A summarized successful tool result salvaged from a child run's events. */
interface PartialObservation {
  toolName: string;
  output: string;
}

const PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT = 600;

/**
 * Salvage the child's most recent successful tool results from its event log so
 * a parent can still use the work even when the child run *failed* (doom-loop,
 * step-limit, error) without ever emitting a final answer. Without this, a child
 * that discovered everything it needed but tripped a guard on the last step
 * returns only an error string, forcing the parent to re-spawn and rediscover
 * the same data from scratch.
 *
 * Pairs `tool.requested` (carries `toolName`) with `tool.completed` (carries the
 * `output`, keyed by `toolCallId`) and returns the last `maxObservations`
 * successful results, each truncated so a large listing cannot blow up the
 * parent's context.
 */
function extractPartialObservations(
  events: readonly SparkwrightEvent[],
  maxObservations: number,
): PartialObservation[] {
  const toolNameByCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.requested") continue;
    const payload = event.payload as
      | { id?: unknown; toolName?: unknown }
      | undefined;
    if (
      typeof payload?.id === "string" &&
      typeof payload.toolName === "string"
    ) {
      toolNameByCallId.set(payload.id, payload.toolName);
    }
  }

  const observations: PartialObservation[] = [];
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const payload = event.payload as
      | { toolCallId?: unknown; output?: unknown }
      | undefined;
    if (payload?.output === undefined) continue;
    const toolName =
      (typeof payload.toolCallId === "string"
        ? toolNameByCallId.get(payload.toolCallId)
        : undefined) ?? "tool";
    let serialized: string;
    try {
      serialized = JSON.stringify(payload.output);
    } catch {
      serialized = String(payload.output);
    }
    if (serialized.length > PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT) {
      serialized = `${serialized.slice(
        0,
        PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT,
      )}… (truncated)`;
    }
    observations.push({ toolName, output: serialized });
  }

  return observations.slice(-maxObservations);
}

function mergeCapabilitySnapshots(
  configured: CapabilitySnapshot,
  last: CapabilitySnapshot | null,
): CapabilitySnapshot {
  if (!last) return configured;
  return {
    tools: mergeByName(configured.tools, last.tools),
    skills: {
      indexed: mergeByName(configured.skills.indexed, last.skills.indexed),
      loaded: last.skills.loaded,
    },
    mcp: {
      statuses: last.mcp.statuses.length
        ? last.mcp.statuses
        : configured.mcp.statuses,
    },
    agents: {
      profiles: mergeById(configured.agents.profiles, last.agents.profiles),
    },
  };
}

function formatToolOrigin(origin: ToolOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const { kind, name } = origin;
  return typeof name === "string" && name ? `${kind}:${name}` : kind;
}

function mergeByName<T extends { name: string }>(base: T[], next: T[]): T[] {
  const byName = new Map<string, T>();
  for (const entry of base) byName.set(entry.name, entry);
  for (const entry of next) byName.set(entry.name, entry);
  return [...byName.values()];
}

function mergeById<T extends { id: string }>(base: T[], next: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of base) byId.set(entry.id, entry);
  for (const entry of next) byId.set(entry.id, entry);
  return [...byId.values()];
}
