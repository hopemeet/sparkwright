import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { join } from "node:path";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { EventStore } from "./state/event-store.js";
import { RunController } from "./state/run-controller.js";
import { ToastStore } from "./state/toast-store.js";
import { QueueStore } from "./state/queue-store.js";
import { LayerStack } from "./state/layer-stack.js";
import { EventStream } from "./components/event-stream.js";
import { InputBox } from "./components/input-box.js";
import { StreamingMessage } from "./components/streaming-message.js";
import { ToastView } from "./components/toast.js";
import { loadSessionLabels, type SessionLabels } from "./lib/session-labels.js";
import { ThemeProvider } from "./lib/theme-context.js";
import { resolveTheme, type Theme } from "./lib/theme.js";
import { loadStash, type StashFile } from "./lib/stash.js";
import type { InputBoxHandle } from "./components/input-box.js";
import { Sidebar, UsageSummaryLine } from "./components/sidebar.js";
import { TodoBand } from "./components/todo-band.js";
import { StatusBar } from "./components/status-bar.js";
import { QueuedMessages } from "./components/queued-messages.js";
import { LayerRenderer } from "./components/layer-renderer.js";
import { resolveDialogColumns } from "./components/dialog-frame.js";
import type {
  CapabilitySnapshot,
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import { AttentionManager } from "./lib/attention.js";
import { CommandRegistry } from "./lib/commands.js";
import {
  createCapability,
  type CreateCapabilityDraft,
} from "./lib/create-capability.js";
import {
  createTuiSkillProposal,
  createTuiSkillProposalFromInput,
  applyTuiSkillReviewProposal,
  formatTuiSkillProposalResult,
  loadTuiSkillReview,
  rejectTuiSkillReviewProposal,
  type TuiSkillReviewDetail,
  type TuiSkillProposalInput,
  updateTuiSkillProposal,
  updateTuiSkillProposalFromInput,
} from "./lib/skill-evolution.js";
import {
  applySkillLearnDraftProposal,
  createSkillLearnDraftProposal,
  detectSkillLearnNotice,
  detectSkillLearnTarget,
  formatSkillLearnStatus,
  parseSkillLearnMode,
  readSkillLearnStatus,
  setProjectSkillLearnMode,
} from "./lib/skill-learn.js";
import type { ProjectCommandDescriptor } from "@sparkwright/project-commands";
import {
  loadProjectCommands,
  resolveProjectCommandIntent,
  toTuiProjectCommands,
} from "./lib/project-commands.js";
import {
  chordMatches,
  ctrlCPressCount,
  formatBinding,
  DEFAULTS as DEFAULT_BINDINGS,
  type Bindings,
} from "./lib/keybindings.js";
import type { SessionDiagnostics, SessionSummary } from "./lib/sessions.js";
import {
  createKindFromRest,
  type CapabilityView,
} from "./lib/layer-payload.js";
import type { PermissionMode, TraceLevel } from "@sparkwright/protocol";
import {
  loadTuiConfig,
  watchTuiConfig,
  type LoadedTuiConfig,
  type SourceMap,
  type TuiConfigFile,
  type ValidationError,
} from "./lib/config.js";
import { formatWorkspaceDisplayPath } from "./lib/path-display.js";
import {
  clampTuiPermissionMode,
  nextAllowedTuiPermissionMode,
  toCoreRunFields,
  type TuiPermissionMode,
} from "./lib/permission.js";
import {
  summarizeTaskActivity,
  type ActivityTab,
} from "./lib/task-activity.js";

export interface CliOverrides {
  workspaceRoot?: string;
  sessionRootDir?: string;
  tuiPermissionMode?: TuiPermissionMode;
  traceLevel?: TraceLevel;
  modelName?: string;
  sessionId?: string;
}

export interface AppProps {
  initialCwd: string;
  cliOverrides: CliOverrides;
}

interface Resolved {
  workspaceRoot: string;
  sessionRootDir: string;
  sessionRootLabel: string;
  tuiPermissionMode: TuiPermissionMode;
  accessModeCeiling?: TuiPermissionMode;
  permissionMode: PermissionMode;
  traceLevel: TraceLevel;
  shouldWrite: boolean;
  /** Model reference "provider/model", or the reserved "deterministic". */
  modelName?: string;
  modelNameSource?: "config" | "request";
  /** Provider definitions (for re-resolving creds on a /model change). */
  providers?: TuiConfigFile["providers"];
  sources: SourceMap;
  attempted: LoadedTuiConfig["attempted"];
  errors: ValidationError[];
  bindings: Bindings;
  theme: Theme;
  mouse: boolean;
  vim: boolean;
}

function resolveConfig(
  loaded: LoadedTuiConfig,
  cli: CliOverrides,
  initialCwd: string,
): Resolved {
  const sources: SourceMap = { ...loaded.sources };
  const workspaceRoot =
    cli.workspaceRoot ?? loaded.config.workspace ?? initialCwd;
  if (cli.workspaceRoot) sources.workspace = "cli:--workspace";
  else if (!loaded.config.workspace) sources.workspace = "default:cwd";
  const sessionRootDir =
    cli.sessionRootDir ?? join(workspaceRoot, ".sparkwright", "sessions");
  const sessionRootLabel = cli.sessionRootDir
    ? sessionRootDir
    : ".sparkwright/sessions";

  const modelName = cli.modelName ?? loaded.config.model;
  const modelNameSource = cli.modelName
    ? ("request" as const)
    : loaded.config.model
      ? ("config" as const)
      : undefined;
  if (cli.modelName) sources.model = "cli:--model";

  const requestedTuiPermissionMode: TuiPermissionMode =
    cli.tuiPermissionMode ?? loaded.config.tuiPermissionMode ?? "ask";
  const tuiPermissionMode = clampTuiPermissionMode(
    loaded.config.accessModeCeiling,
    requestedTuiPermissionMode,
  );
  if (cli.tuiPermissionMode) {
    sources.tuiPermissionMode =
      tuiPermissionMode === requestedTuiPermissionMode
        ? "cli:--access-mode"
        : (loaded.sources.accessModeCeiling ?? "project ceiling");
  } else if (!loaded.config.tuiPermissionMode) {
    sources.tuiPermissionMode = "default";
  }
  const corePermission = toCoreRunFields(tuiPermissionMode);
  const permissionMode = corePermission.permissionMode;
  const shouldWrite = corePermission.shouldWrite;
  const traceLevel: TraceLevel = cli.traceLevel ?? "standard";

  if (!loaded.config.theme) sources.theme = "default";

  return {
    workspaceRoot,
    sessionRootDir,
    sessionRootLabel,
    tuiPermissionMode,
    accessModeCeiling: loaded.config.accessModeCeiling,
    permissionMode,
    traceLevel,
    shouldWrite,
    modelName,
    modelNameSource,
    providers: loaded.config.providers,
    sources,
    attempted: loaded.attempted,
    errors: loaded.errors,
    bindings: loaded.config.resolvedBindings ?? DEFAULT_BINDINGS,
    theme: resolveTheme(loaded.config.theme),
    mouse: loaded.config.mouse ?? true,
    vim: loaded.config.vim ?? false,
  };
}

/**
 * Flatten the providers map into "provider/model" refs for the model picker.
 * Sourced from each provider's `models` keys; providers with no models listed
 * contribute nothing (the dialog still accepts free-text for those).
 */
function modelCandidates(providers: Resolved["providers"]): string[] {
  if (!providers) return [];
  const refs: string[] = [];
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const modelId of Object.keys(provider.models ?? {})) {
      refs.push(`${providerKey}/${modelId}`);
    }
  }
  return refs;
}

export function App(props: AppProps): React.ReactElement {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadTuiConfig(props.initialCwd).then((loaded) => {
      if (cancelled) return;
      const r = resolveConfig(loaded, props.cliOverrides, props.initialCwd);
      setResolved(r);
    });
    return () => {
      cancelled = true;
    };
  }, [props.initialCwd, props.cliOverrides]);

  if (!resolved) {
    return (
      <Box paddingX={1}>
        <Text dimColor>loading config…</Text>
      </Box>
    );
  }
  return <AppReady {...props} resolved={resolved} setResolved={setResolved} />;
}

function AppReady(
  props: AppProps & {
    resolved: Resolved;
    setResolved: (r: Resolved) => void;
  },
): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout, write: writeToStdout } = useStdout();
  const { resolved } = props;

  const store = useMemo(() => new EventStore(), []);
  const layers = useMemo(() => new LayerStack(), []);
  const toasts = useMemo(() => new ToastStore(), []);
  const queue = useMemo(() => new QueueStore(), []);
  const attention = useMemo(() => new AttentionManager(), []);
  const controller = useMemo(
    () =>
      new RunController({
        workspaceRoot: resolved.workspaceRoot,
        sessionRootDir: resolved.sessionRootDir,
        tuiPermissionMode: resolved.tuiPermissionMode,
        traceLevel: resolved.traceLevel,
        modelName: resolved.modelName,
        modelNameSource: resolved.modelNameSource,
        initialSessionId: props.cliOverrides.sessionId,
        store,
      }),
    [resolved.workspaceRoot, resolved.sessionRootDir, store],
  );
  const initialSessionLoadedRef = useRef(false);

  useEffect(() => {
    const initialSessionId = props.cliOverrides.sessionId;
    if (!initialSessionId || initialSessionLoadedRef.current) return;
    initialSessionLoadedRef.current = true;
    void controller.switchSession(initialSessionId);
  }, [controller, props.cliOverrides.sessionId]);

  // Track the terminal height only to cap the live (in-flight) stream panel so
  // a long streaming message can't push the input box off-screen. Committed
  // transcript lines live in scrollback (<Static>), so the overall frame is no
  // longer clamped to the viewport.
  const [termRows, setTermRows] = useState<number>(stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setTermRows(stdout.rows ?? 24);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const layerSnapshot = useSyncExternalStore(
    layers.subscribe,
    layers.getSnapshot,
  );
  const topLayer = layerSnapshot[layerSnapshot.length - 1] ?? null;
  const toastSnapshot = useSyncExternalStore(
    toasts.subscribe,
    toasts.getSnapshot,
  );
  const queued = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [focused, setFocused] = useState(true);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [sessionDiagnostics, setSessionDiagnostics] =
    useState<SessionDiagnostics | null>(null);
  const [loadingDiagnosticsFor, setLoadingDiagnosticsFor] = useState<
    string | null
  >(null);
  const [capabilitySnapshot, setCapabilitySnapshot] =
    useState<CapabilitySnapshot | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [taskRecords, setTaskRecords] = useState<TaskRecordSnapshot[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<
    Record<string, TaskOutputChunkSnapshot[]>
  >({});
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [skillReviewSnapshot, setSkillReviewSnapshot] =
    useState<TuiSkillReviewDetail | null>(null);
  const [loadingSkillReview, setLoadingSkillReview] = useState(false);
  const [skillReviewRest, setSkillReviewRest] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const labelsRef = useRef<SessionLabels | null>(null);
  // Ctrl+C behaves like a safe escape hatch: first press cancels/backs out,
  // second press exits when idle with no layer open.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const theme = resolved.theme;
  // Todo band: collapsed by default (active items only); ctrl+t expands to show
  // completed items too.
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [lastActivityTab, setLastActivityTab] = useState<ActivityTab>("tasks");
  const [lastSeenTaskSequence, setLastSeenTaskSequence] = useState(0);
  // Prompt stash bridge — the InputBox reads/writes through this ref.
  const stashRef = useRef<StashFile>({ current: null, list: [] });
  const inputHandleRef = useRef<InputBoxHandle | null>(null);
  // Runtime model-ref override from /model; falls back to config.
  const [modelOverride, setModelOverride] = useState<{
    modelName?: string;
  } | null>(null);
  const effModel = modelOverride ? modelOverride.modelName : resolved.modelName;
  const [permissionModeOverride, setPermissionModeOverride] =
    useState<TuiPermissionMode | null>(null);
  const requestedEffTuiPermissionMode =
    permissionModeOverride ?? resolved.tuiPermissionMode;
  const effTuiPermissionMode = clampTuiPermissionMode(
    resolved.accessModeCeiling,
    requestedEffTuiPermissionMode,
  );
  const effCorePermission = toCoreRunFields(effTuiPermissionMode);
  const effectiveResolved = useMemo<Resolved>(() => {
    const next: Resolved = {
      ...resolved,
      tuiPermissionMode: effTuiPermissionMode,
      permissionMode: effCorePermission.permissionMode,
      shouldWrite: effCorePermission.shouldWrite,
    };
    if (permissionModeOverride) {
      next.sources = {
        ...resolved.sources,
        tuiPermissionMode:
          effTuiPermissionMode === requestedEffTuiPermissionMode
            ? "runtime:shift+tab"
            : (resolved.sources.accessModeCeiling ?? "project ceiling"),
      };
    }
    return next;
  }, [
    resolved,
    effTuiPermissionMode,
    requestedEffTuiPermissionMode,
    effCorePermission.permissionMode,
    effCorePermission.shouldWrite,
    permissionModeOverride,
  ]);
  const skillLearnGoalsRef = useRef<string[]>([]);
  const skillLearnNoticeCountRef = useRef(0);
  const quitArmedUntilRef = useRef(0);
  const lastQuitRequestAtRef = useRef(0);
  const suppressQuitUntilRef = useRef(0);
  const requestQuitRef = useRef<(presses?: number) => void>(() => {});

  // Sync awaiting-approval status with a layer entry so the layer stack is
  // the single source of truth for "what's on top".
  useEffect(() => {
    if (state.pendingApproval) layers.push("approval", state.pendingApproval);
    else layers.pop("approval");
  }, [state.pendingApproval, layers]);

  // Load session labels once per workspace.
  useEffect(() => {
    let cancelled = false;
    void loadSessionLabels(resolved.workspaceRoot).then((store) => {
      if (cancelled) return;
      labelsRef.current = store;
      setLabels(store.get());
    });
    return () => {
      cancelled = true;
    };
  }, [resolved.workspaceRoot]);

  // Load the prompt stash once per workspace so the InputBox can restore a
  // crashed/abandoned draft on mount.
  useEffect(() => {
    let cancelled = false;
    void loadStash(resolved.workspaceRoot).then((s) => {
      if (cancelled) return;
      stashRef.current = s;
    });
    return () => {
      cancelled = true;
    };
  }, [resolved.workspaceRoot]);

  // Attention: emit BEL + OSC 9 when something demands focus AND we're blurred.
  useEffect(() => {
    attention.enable();
    const unsub = attention.onChange(setFocused);
    return () => {
      unsub();
      attention.disable();
    };
  }, [attention]);

  useEffect(() => {
    skillLearnGoalsRef.current = [];
    skillLearnNoticeCountRef.current = 0;
  }, [state.sessionId]);

  // Scroll is the terminal's job now: the transcript is committed to native
  // scrollback via <Static>, so we deliberately do NOT enable mouse reporting
  // (which would capture the wheel and break native scrollback). `resolved.mouse`
  // is reserved for future click-based affordances.

  // Wipe the screen + scrollback when /clear or /new bumps the generation, then
  // let the remounted <Static> (keyed on the same counter) reprint from empty.
  // <Static> can't un-print committed lines, so an explicit wipe is required.
  //
  // Route the wipe through Ink's writeToStdout (NOT a raw stdout.write): it
  // clears Ink's live region, writes our escape, then re-logs the current live
  // frame. A raw write leaves the frame blank until Ink next repaints — and Ink
  // skips repaints when the live output is unchanged, so the screen would stay
  // black until the user typed or the spinner ticked.
  const lastClearGen = useRef(state.clearGeneration);
  useEffect(() => {
    if (state.clearGeneration === lastClearGen.current) return;
    lastClearGen.current = state.clearGeneration;
    writeToStdout("\x1b[2J\x1b[3J\x1b[H");
  }, [state.clearGeneration, writeToStdout]);

  const writeToStdoutRef = useRef(writeToStdout);
  useEffect(() => {
    writeToStdoutRef.current = writeToStdout;
  }, [writeToStdout]);

  useLayoutEffect(() => {
    if (topLayer?.name !== "events") return;
    writeToStdoutRef.current("\x1b[?1049h\x1b[2J\x1b[H");
    return () => {
      writeToStdoutRef.current("\x1b[?1049l");
    };
  }, [topLayer?.name]);

  // Notify on approval requests and run failures.
  const lastApprovalId = useRef<string | null>(null);
  useEffect(() => {
    if (
      state.pendingApproval &&
      state.pendingApproval.id !== lastApprovalId.current
    ) {
      lastApprovalId.current = state.pendingApproval.id;
      attention.notify(`approval needed: ${state.pendingApproval.summary}`);
    } else if (!state.pendingApproval) {
      lastApprovalId.current = null;
    }
  }, [state.pendingApproval, attention]);

  const lastStatus = useRef(state.status);
  useEffect(() => {
    if (
      lastStatus.current === "running" &&
      (state.status === "done" || state.status === "error")
    ) {
      if (state.status === "error") {
        attention.notify("run failed");
        toasts.push({
          variant: "error",
          title: "run failed",
          message: state.lastError ?? "unknown error",
        });
      } else {
        const cancelledRun =
          state.stopReason === "manual_cancelled" ||
          state.stopReason === "user_cancelled";
        if (cancelledRun && toastSnapshot.current?.variant === "error") {
          toasts.dismiss();
        }
        attention.notify(cancelledRun ? "run cancelled" : "run done");
        toasts.push({
          variant: cancelledRun ? "info" : "success",
          title: cancelledRun ? "run cancelled" : "run done",
          message: cancelledRun
            ? "cancelled"
            : (state.stopReason ?? "completed"),
        });
        const goals = skillLearnGoalsRef.current;
        const notice = detectSkillLearnNotice(goals);
        if (notice && goals.length > skillLearnNoticeCountRef.current) {
          const goalCount = goals.length;
          const sessionId = state.sessionId;
          const targetSkillName = detectSkillLearnTarget(goals);
          void readSkillLearnStatus(resolved.workspaceRoot)
            .then((status) => {
              if (status.mode === "off") return;
              if (sessionId !== state.sessionId) return;
              if (status.mode === "notice") {
                skillLearnNoticeCountRef.current = goalCount;
                toasts.push({
                  variant: "info",
                  title: "skill learn",
                  message: `${notice.reason}. Run /skill-create or /skill-update <skill-name>.`,
                  durationMs: 9000,
                });
                return;
              }
              void createSkillLearnDraftProposal(
                resolved.workspaceRoot,
                notice,
                {
                  ...(targetSkillName ? { targetSkillName } : {}),
                  ...(sessionId ? { sessionId } : {}),
                },
              )
                .then((proposal) => {
                  if (sessionId !== state.sessionId) return;
                  if (status.mode === "draft") {
                    skillLearnNoticeCountRef.current = goalCount;
                    toasts.push({
                      variant: "success",
                      title: "skill learn draft",
                      message: `${proposal.kind} ${proposal.skillName} -> ${proposal.id}`,
                      durationMs: 9000,
                    });
                    return;
                  }
                  void applySkillLearnDraftProposal(
                    resolved.workspaceRoot,
                    proposal,
                  )
                    .then((applied) => {
                      if (sessionId !== state.sessionId) return;
                      skillLearnNoticeCountRef.current = goalCount;
                      // Apply mode writes automatically (the user opted in), so
                      // the toast must be transparent: show what was learned,
                      // the version written, and how to inspect/undo. (We point
                      // to `skills history` rather than a `restore --version`
                      // one-liner: restoring to the just-written version is a
                      // no-op, and the first apply has no prior version.)
                      const learned =
                        notice.evidence.length > 80
                          ? `${notice.evidence.slice(0, 77)}...`
                          : notice.evidence;
                      toasts.push({
                        variant: "success",
                        title: "skill learn applied",
                        message: `learned "${learned}" → ${proposal.skillName} (v ${applied.historyId}). undo: skills history ${proposal.skillName}`,
                        durationMs: 14000,
                      });
                    })
                    .catch((error: unknown) => {
                      if (sessionId !== state.sessionId) return;
                      skillLearnNoticeCountRef.current = goalCount;
                      toasts.push({
                        variant: "warning",
                        title: "skill learn draft",
                        message: `left draft ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`,
                        durationMs: 9000,
                      });
                    });
                })
                .catch((error: unknown) => {
                  toasts.push({
                    variant: "error",
                    title: "skill learn draft failed",
                    message:
                      error instanceof Error ? error.message : String(error),
                    durationMs: 9000,
                  });
                });
            })
            .catch(() => {});
        }
      }
    }
    lastStatus.current = state.status;
  }, [
    state.status,
    state.lastError,
    state.stopReason,
    state.sessionId,
    resolved.workspaceRoot,
    attention,
    toasts,
  ]);

  async function reloadConfig(verbose: boolean): Promise<void> {
    const loaded = await loadTuiConfig(props.initialCwd);
    const r = resolveConfig(loaded, props.cliOverrides, props.initialCwd);
    if (!modelOverride && r.modelName !== resolved.modelName) {
      controller.updateModel(r.modelName, r.modelNameSource);
    }
    if (
      !permissionModeOverride &&
      r.tuiPermissionMode !== resolved.tuiPermissionMode
    ) {
      controller.updateTuiPermissionMode(r.tuiPermissionMode);
    }
    if (r.traceLevel !== resolved.traceLevel) {
      controller.updateTraceLevel(r.traceLevel);
    }
    props.setResolved(r);
    // Re-discover file-authored commands so newly added .sparkwright/command/*.md
    // files appear without a restart (mirrors config reload).
    void loadProjectCommands(r.workspaceRoot)
      .then(setProjectCommands)
      .catch(() => setProjectCommands([]));
    if (verbose) {
      if (r.errors.length > 0)
        toasts.push({
          variant: "warning",
          title: "config reloaded",
          message: `${r.errors.length} validation error(s) — see /config`,
        });
      else
        toasts.push({
          variant: "success",
          title: "config reloaded",
          message: "applied",
        });
    }
  }

  useEffect(() => {
    const dispose = watchTuiConfig(props.initialCwd, () => {
      void reloadConfig(true);
    });
    return dispose;
  }, [props.initialCwd]);

  async function openSessionList(): Promise<void> {
    const sessions = await controller.listSessions();
    setSessionDiagnostics(null);
    setLoadingDiagnosticsFor(null);
    setSessionList(sessions);
    layers.push("sessions");
  }

  async function inspectSession(id: string): Promise<void> {
    setLoadingDiagnosticsFor(id);
    const diagnostics = await controller.inspectSession(id);
    setLoadingDiagnosticsFor(null);
    if (diagnostics) setSessionDiagnostics(diagnostics);
  }

  async function openCapabilities(view: CapabilityView = "all"): Promise<void> {
    setLoadingCapabilities(true);
    layers.push("capabilities", { view });
    const snapshot = await controller.inspectCapabilities();
    setLoadingCapabilities(false);
    if (snapshot) setCapabilitySnapshot(snapshot);
  }

  function openCreateCapability(rest = ""): void {
    const kind = createKindFromRest(rest);
    if (rest.trim() && !kind) {
      toasts.push({
        variant: "error",
        title: "create",
        message: "use /create skill|agent|cron|command|mcp",
      });
      return;
    }
    layers.push("create", { kind });
  }

  async function handleCreateCapability(
    draft: CreateCapabilityDraft,
  ): Promise<void> {
    try {
      const result = await createCapability(draft, resolved.workspaceRoot);
      layers.pop("create");
      toasts.push({
        variant: "success",
        title: "created",
        message: result.path
          ? `${result.message} · ${formatWorkspaceDisplayPath(result.path, {
              workspaceRoot: resolved.workspaceRoot,
              maxCols: 72,
            })}`
          : result.message,
      });
      const snapshot = await controller.inspectCapabilities();
      if (snapshot) setCapabilitySnapshot(snapshot);
    } catch (error) {
      toasts.push({
        variant: "error",
        title: "create failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // File-authored slash commands discovered from .sparkwright/command/*.md.
  // Loaded async after mount; the registry memo below folds them in.
  const [projectCommands, setProjectCommands] = useState<
    ProjectCommandDescriptor[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    void loadProjectCommands(resolved.workspaceRoot)
      .then((cmds) => {
        if (!cancelled) setProjectCommands(cmds);
      })
      .catch(() => {
        if (!cancelled) setProjectCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [resolved.workspaceRoot]);

  // Keep a live ref to handleSubmit so project commands (captured in the memo)
  // always submit through the current render's queue/run state, not a stale one.
  const submitRef = useRef<(value: string) => void>(() => {});
  useEffect(() => {
    submitRef.current = handleSubmit;
  });

  function runProjectCommand(
    descriptor: ProjectCommandDescriptor,
    rest: string,
  ): void {
    void resolveProjectCommandIntent(descriptor, rest, resolved.workspaceRoot)
      .then((intent) => submitRef.current(intent.prompt))
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: `/${descriptor.name} failed`,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function createSkillProposalFromSlash(rest: string): void {
    void createTuiSkillProposal(resolved.workspaceRoot, rest)
      .then((proposal) => {
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-create failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function openSkillCreateProposal(rest = ""): void {
    if (rest.trim().length > 0) {
      createSkillProposalFromSlash(rest);
      return;
    }
    layers.push("skill-create");
  }

  function handleCreateSkillProposal(draft: TuiSkillProposalInput): void {
    void createTuiSkillProposalFromInput(resolved.workspaceRoot, draft)
      .then((proposal) => {
        layers.pop("skill-create");
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-create failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function updateSkillProposalFromSlash(rest: string): void {
    void updateTuiSkillProposal(resolved.workspaceRoot, rest)
      .then((proposal) => {
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-update failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function openSkillUpdateProposal(rest = ""): void {
    const trimmed = rest.trim();
    if (!trimmed) {
      layers.push("skill-update");
      return;
    }
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
      layers.push("skill-update", { name: trimmed });
      return;
    }
    updateSkillProposalFromSlash(rest);
  }

  function handleUpdateSkillProposal(draft: TuiSkillProposalInput): void {
    void updateTuiSkillProposalFromInput(resolved.workspaceRoot, draft)
      .then((proposal) => {
        layers.pop("skill-update");
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-update failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function reviewSkillProposalsFromSlash(rest: string): void {
    setSkillReviewRest(rest);
    setLoadingSkillReview(true);
    setSkillReviewSnapshot(null);
    layers.push("skill-review");
    void loadTuiSkillReview(resolved.workspaceRoot, rest)
      .then((review) => {
        setSkillReviewSnapshot(review);
        setLoadingSkillReview(false);
      })
      .catch((error: unknown) => {
        setLoadingSkillReview(false);
        toasts.push({
          variant: "error",
          title: "/skill-review failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function refreshSkillReview(): void {
    setLoadingSkillReview(true);
    void loadTuiSkillReview(resolved.workspaceRoot, skillReviewRest)
      .then((review) => {
        setSkillReviewSnapshot(review);
        setLoadingSkillReview(false);
      })
      .catch((error: unknown) => {
        setLoadingSkillReview(false);
        toasts.push({
          variant: "error",
          title: "/skill-review refresh failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function applySkillReviewProposal(proposalId: string): void {
    void applyTuiSkillReviewProposal(resolved.workspaceRoot, proposalId)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill proposal applied",
          message: `${result.id} -> ${result.historyId ?? "history"}`,
          durationMs: 7000,
        });
        refreshSkillReview();
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "skill proposal apply failed",
          message: error instanceof Error ? error.message : String(error),
          durationMs: 9000,
        });
      });
  }

  function rejectSkillReviewProposal(proposalId: string): void {
    void rejectTuiSkillReviewProposal(resolved.workspaceRoot, proposalId)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill proposal rejected",
          message: `${result.id} ${result.skillName}`,
          durationMs: 7000,
        });
        refreshSkillReview();
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "skill proposal reject failed",
          message: error instanceof Error ? error.message : String(error),
          durationMs: 9000,
        });
      });
  }

  function handleSkillLearn(rest = ""): void {
    let mode: ReturnType<typeof parseSkillLearnMode>;
    try {
      mode = parseSkillLearnMode(rest);
    } catch (error) {
      toasts.push({
        variant: "error",
        title: "/skill-learn failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!mode) {
      void readSkillLearnStatus(resolved.workspaceRoot)
        .then((status) => {
          toasts.push({
            variant: "info",
            title: "skill learn",
            message: formatSkillLearnStatus(status),
          });
        })
        .catch((error: unknown) => {
          toasts.push({
            variant: "error",
            title: "/skill-learn failed",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    void setProjectSkillLearnMode(resolved.workspaceRoot, mode)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill learn",
          message: `${result.mode} -> ${formatWorkspaceDisplayPath(
            result.path,
            {
              workspaceRoot: resolved.workspaceRoot,
              maxCols: 72,
            },
          )}`,
        });
        void reloadConfig(true);
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-learn failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // Build the command registry once per controller. App-level handlers are
  // closed over here and invoked later via slash input.
  const registry = useMemo(() => {
    const reg = new CommandRegistry();
    reg.register({
      name: "help",
      title: "Show keyboard help",
      description: "Toggle the keymap/help panel.",
      category: "view",
      hint: formatBinding(resolved.bindings["help.open"]) || undefined,
      run: () => layers.toggle("help"),
    });
    reg.register({
      name: "clear",
      title: "Clear event stream",
      description: "Wipes visible events; keeps session id.",
      category: "view",
      run: () => {
        store.clearEvents();
        toasts.push({ message: "events cleared", variant: "info" });
      },
    });
    reg.register({
      name: "new",
      title: "Start a new session",
      description: "Generates a fresh session id.",
      category: "session",
      run: () => {
        const id = controller.newSession();
        toasts.push({
          title: "new session",
          message: id,
          variant: "success",
        });
      },
    });
    reg.register({
      name: "retry",
      title: "Re-run last goal",
      description: "Submit the most recent goal again in this session.",
      category: "session",
      run: () => {
        void controller.retry().then((ok) => {
          if (ok) return;
          toasts.push({
            title: "nothing to retry",
            message: controller.getLastGoal()
              ? "a run is already active"
              : "no goal has been run yet",
            variant: "info",
          });
        });
      },
    });
    reg.register({
      name: "compact",
      title: "Compact prior context",
      description: "Summarize completed turns for future runs in this session.",
      category: "session",
      run: () => {
        void controller.compactSession().then((result) => {
          if (!result) return;
          if (result.skippedReason) {
            toasts.push({
              variant: "info",
              title: "compact",
              message: result.warnings?.[0]?.message
                ? `${result.skippedReason}: ${result.warnings[0].message}`
                : result.skippedReason,
            });
            return;
          }
          const before = result.originalCharCount;
          const after = result.summaryCharCount;
          const pct =
            before > 0
              ? ` · ${Math.max(0, Math.round((1 - after / before) * 100))}% smaller`
              : "";
          toasts.push({
            variant: "success",
            title: "context compacted",
            message: `${result.compactedRunCount} turn${result.compactedRunCount === 1 ? "" : "s"}${pct}`,
          });
        });
      },
    });
    reg.register({
      name: "sessions",
      title: "Browse past sessions",
      description: "List, inspect diagnostics, resume.",
      category: "session",
      run: () => void openSessionList(),
    });
    reg.register({
      name: "events",
      title: "Open Activity Events",
      description: "Open the activity drawer on the event stream.",
      category: "view",
      hint: formatBinding(resolved.bindings["events.open"]) || undefined,
      aliases: ["inspect", "inspector"],
      run: () => openActivity("events"),
    });
    reg.register({
      name: "tasks",
      title: "Open Background Tasks",
      description: "Open the activity drawer on durable background tasks.",
      category: "view",
      hint: formatBinding(resolved.bindings["activity.open"]) || undefined,
      run: () => openActivity("tasks"),
    });
    reg.register({
      name: "config",
      title: "Show resolved config",
      description: "Where each field came from.",
      category: "config",
      run: () => layers.toggle("config"),
    });
    reg.register({
      name: "capabilities",
      title: "Browse available capabilities",
      description:
        "Discover tools, Skills, MCP servers, agents, and cron support.",
      category: "view",
      aliases: ["caps"],
      run: () => void openCapabilities("all"),
    });
    reg.register({
      name: "create",
      title: "Create capability",
      description:
        "Create a Skill, agent, cron job, slash command, or MCP server.",
      category: "capability",
      hiddenByDefault: true,
      run: () => openCreateCapability(),
      runRaw: (rest) => openCreateCapability(rest),
    });
    reg.register({
      name: "tools",
      title: "Browse tools",
      description: "Show prepared tools, risk, and origin.",
      category: "view",
      hiddenByDefault: true,
      run: () => void openCapabilities("tools"),
    });
    reg.register({
      name: "skills",
      title: "Browse Skills",
      description: "Show Skills SparkWright can discover or load.",
      category: "view",
      hiddenByDefault: true,
      run: () => void openCapabilities("skills"),
    });
    reg.register({
      name: "skill-create",
      title: "Draft Skill proposal",
      description:
        "Create a project Skill proposal interactively or from arguments.",
      category: "capability",
      hiddenByDefault: true,
      run: () => openSkillCreateProposal(),
      runRaw: openSkillCreateProposal,
    });
    reg.register({
      name: "skill-update",
      title: "Draft Skill update",
      description:
        "Create a hash-gated update/fork proposal interactively or from arguments.",
      category: "capability",
      hiddenByDefault: true,
      run: () => openSkillUpdateProposal(),
      runRaw: openSkillUpdateProposal,
    });
    reg.register({
      name: "skill-review",
      title: "Review Skill proposals",
      description:
        "Summarize recent Skill proposals; optionally pass a state like draft.",
      category: "capability",
      hiddenByDefault: true,
      run: () => reviewSkillProposalsFromSlash(""),
      runRaw: reviewSkillProposalsFromSlash,
    });
    reg.register({
      name: "skill-learn",
      title: "Set Skill learning mode",
      description:
        "Show or set Skill Evolution mode: off, notice, draft, apply.",
      category: "capability",
      hiddenByDefault: true,
      run: () => handleSkillLearn(""),
      runRaw: handleSkillLearn,
    });
    reg.register({
      name: "agents",
      title: "Browse agents",
      description: "Show configured agent profiles.",
      category: "view",
      hiddenByDefault: true,
      run: () => void openCapabilities("agents"),
    });
    reg.register({
      name: "mcp",
      title: "Browse MCP servers",
      description: "Show configured MCP servers and their exposed tools.",
      category: "view",
      hiddenByDefault: true,
      run: () => void openCapabilities("mcp"),
    });
    reg.register({
      name: "cron",
      title: "Browse automation status",
      description: "Show cron jobs and durable background task state.",
      category: "view",
      hiddenByDefault: true,
      run: () => void openCapabilities("cron"),
    });
    reg.register({
      name: "model",
      title: "Switch model",
      description: "Change the model reference for the next run.",
      category: "config",
      run: () => layers.toggle("model"),
    });
    reg.register({
      name: "image",
      title: "Attach image",
      description: "Attach a local image to the next submitted goal.",
      category: "capability",
      aliases: ["attach-image"],
      run: () =>
        toasts.push({
          variant: "info",
          title: "image",
          message: "usage: /image <path>",
        }),
      runRaw: (rest) => {
        void controller.attachImage(rest).then((result) => {
          if (!result.ok) {
            toasts.push({
              variant: "error",
              title: "image failed",
              message: result.message,
            });
            return;
          }
          toasts.push({
            variant: "success",
            title: "image attached",
            message: `${result.name} · ${result.count} pending`,
          });
        });
      },
    });
    reg.register({
      name: "clear-images",
      title: "Clear attached images",
      description: "Remove pending image attachments for the next goal.",
      category: "capability",
      hiddenByDefault: true,
      run: () => {
        const count = controller.pendingAttachmentCount();
        controller.clearPendingAttachments();
        toasts.push({
          variant: "info",
          title: "images cleared",
          message: `${count} pending`,
        });
      },
    });
    reg.register({
      name: "fork",
      title: "Fork session at a turn",
      description: "Branch a new session from a chosen point in history.",
      category: "session",
      run: () => layers.toggle("fork"),
    });
    reg.register({
      name: "export",
      title: "Export session transcript",
      description:
        "Render the current session as markdown to .sparkwright/exports/.",
      category: "session",
      run: () => {
        controller
          .exportTranscript()
          .then((path) => {
            store.appendTranscriptExport(path);
            toasts.push({
              variant: "success",
              title: "transcript exported",
              message: path,
            });
          })
          .catch((err) =>
            toasts.push({
              variant: "error",
              title: "export failed",
              message: String(err),
            }),
          );
      },
    });
    reg.register({
      name: "rename",
      title: "Rename current session",
      description: "Give the current session a human-friendly label.",
      category: "session",
      run: () => {
        if (state.sessionId) setRenameTarget(state.sessionId);
        layers.push("session-rename");
      },
    });
    reg.register({
      name: "quit",
      title: "Quit",
      description: "Exit the TUI.",
      category: "system",
      hint: formatBinding(resolved.bindings["quit.app"]) || undefined,
      aliases: ["exit", "q"],
      run: () => exit(),
    });
    // File-authored commands last: a built-in of the same name wins because
    // CommandRegistry.register overwrites, and built-ins are the precise layer.
    for (const cmd of toTuiProjectCommands(
      projectCommands,
      runProjectCommand,
    )) {
      if (!reg.resolve(cmd.name)) reg.register(cmd);
    }
    return reg;
    // Re-build when keybindings change so hint strings refresh, when the
    // current session id changes so /rename targets the right session, and when
    // project-authored commands are reloaded.
  }, [
    layers,
    controller,
    toasts,
    state.sessionId,
    resolved.bindings,
    resolved.workspaceRoot,
    projectCommands,
  ]);

  function startGoal(value: string): void {
    quitArmedUntilRef.current = 0;
    if (toastSnapshot.current?.variant === "error") toasts.dismiss();
    skillLearnGoalsRef.current.push(value);
    void controller.start(value);
  }

  function handleSubmit(value: string): void {
    // A run accepts one goal at a time. If one's already in flight (running or
    // paused on an approval), queue the submission instead of dropping it — the
    // drain effect below starts it once the current run finishes.
    if (state.status === "running" || state.status === "awaiting-approval") {
      queue.enqueue(value);
      toasts.push({
        variant: "info",
        message: `queued · ${queue.size} waiting`,
      });
      return;
    }
    if (state.stopReason === "manual_cancelled" && queued.length > 0) {
      toasts.push({
        variant: "info",
        message: `${queued.length} queued prompt${queued.length === 1 ? "" : "s"} paused after cancel`,
      });
    }
    startGoal(value);
  }

  function requestQuit(presses = 1): void {
    const now = Date.now();
    if (presses < 2 && suppressQuitUntilRef.current > now) return;
    const duplicatePhysicalPress =
      presses < 2 && now - lastQuitRequestAtRef.current < 150;
    lastQuitRequestAtRef.current = now;
    if (duplicatePhysicalPress) return;
    if (presses >= 2 || quitArmedUntilRef.current > now) {
      exit();
      return;
    }
    if (state.status === "running") {
      quitArmedUntilRef.current = now + 1500;
      if (controller.cancel())
        toasts.push({ variant: "info", message: "cancelling…" });
      return;
    }
    if (topLayer?.name === "approval" && state.pendingApproval) {
      quitArmedUntilRef.current = now + 1500;
      controller.resolveApproval("denied");
      return;
    }
    if (topLayer) {
      quitArmedUntilRef.current = now + 1500;
      closeTopLayer();
      return;
    }
    quitArmedUntilRef.current = now + 1500;
    toasts.push({
      variant: "info",
      message: "press ctrl+c again to quit",
      durationMs: 1500,
    });
  }

  function noteInputClearedByQuit(): void {
    const now = Date.now();
    quitArmedUntilRef.current = 0;
    lastQuitRequestAtRef.current = now;
    suppressQuitUntilRef.current = now + 750;
  }

  useEffect(() => {
    requestQuitRef.current = requestQuit;
  });

  useEffect(() => {
    const onSigint = (): void => requestQuitRef.current(1);
    process.on("SIGINT", onSigint);
    return () => {
      process.off("SIGINT", onSigint);
    };
  }, []);

  // Drain the prompt queue: when a run finishes and the controller is free,
  // start the next queued goal. Gated on `controller.isRunning()` so we never
  // double-start, and only on a settled status so an in-flight run is left
  // alone. Errors pause draining (the user likely wants to look) — they can
  // resubmit to resume.
  useEffect(() => {
    if (state.status !== "done" && state.status !== "idle") return;
    if (state.stopReason === "manual_cancelled") return;
    if (controller.isRunning() || queued.length === 0) return;
    const next = queue.dequeue();
    if (next) startGoal(next);
  }, [state.status, state.stopReason, queued.length, controller, queue]);

  // Layer-aware hotkeys: when a layer owns input, the App-level hotkeys
  // step back so they don't double-handle keys. Each binding is resolved
  // through `resolved.bindings`, so user config overrides take effect after
  // the config watcher reloads.
  function Hotkeys(): null {
    const b = resolved.bindings;
    useInput((input, key) => {
      const top = layers.top();
      if (b["quit.app"].some((c) => chordMatches(c, key, input))) {
        if (!top) return;
        requestQuit(Math.max(1, ctrlCPressCount(input)));
        return;
      }
      if (
        top?.name !== "approval" &&
        b["activity.open"].some((c) => chordMatches(c, key, input))
      ) {
        openActivity();
        return;
      }
      if (!top && b["events.open"].some((c) => chordMatches(c, key, input))) {
        openActivity("events");
        return;
      }
      if (
        !top &&
        state.status !== "running" &&
        b["help.open"].some((c) => chordMatches(c, key, input))
      ) {
        layers.toggle("help");
        return;
      }
      if (
        !top &&
        b["cycle-permission-mode"].some((c) => chordMatches(c, key, input))
      ) {
        cyclePermissionMode();
        return;
      }
      if (
        !top &&
        state.todoItems.length > 0 &&
        b["todo.toggle"].some((c) => chordMatches(c, key, input))
      ) {
        setTodoExpanded((v) => !v);
        return;
      }
      if (
        !top &&
        state.status === "running" &&
        b["cancel.run"].some((c) => chordMatches(c, key, input))
      ) {
        if (controller.cancel())
          toasts.push({ variant: "info", message: "cancelling…" });
      }
    });
    return null;
  }

  const modelLabel = effModel ?? "deterministic";
  const taskActivity = useMemo(
    () => summarizeTaskActivity(state.events, taskRecords, taskOutputs),
    [state.events, taskRecords, taskOutputs],
  );
  const unreadTaskCount = taskActivity.tasks.filter(
    (task) =>
      task.lastSequence > lastSeenTaskSequence &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"),
  ).length;
  const unreadFailedTaskCount = taskActivity.tasks.filter(
    (task) =>
      task.lastSequence > lastSeenTaskSequence &&
      (task.status === "failed" || task.status === "cancelled"),
  ).length;

  async function refreshTaskSnapshots(): Promise<void> {
    setLoadingTasks(true);
    try {
      const records = await loadSessionTaskRecords();
      const outputEntries = await Promise.all(
        records
          .slice(0, 12)
          .map(
            async (record): Promise<[string, TaskOutputChunkSnapshot[]]> => [
              record.id,
              await controller.readTaskOutput(record.id, 200),
            ],
          ),
      );
      const outputs: Record<string, TaskOutputChunkSnapshot[]> =
        Object.fromEntries(outputEntries);
      setTaskRecords(records);
      setTaskOutputs(outputs);
    } finally {
      setLoadingTasks(false);
    }
  }

  async function loadSessionTaskRecords(): Promise<TaskRecordSnapshot[]> {
    const runIds = runIdsFromEvents(state.events);
    if (runIds.length === 0) return [];
    const batches = await Promise.all(
      runIds.map((parentRunId) =>
        controller.listTasks({ parentRunId, limit: 50 }),
      ),
    );
    return mergeTaskRecords(batches.flat()).slice(0, 50);
  }

  function handleActivityTabChange(tab: ActivityTab): void {
    setLastActivityTab(tab);
    if (tab === "tasks") void refreshTaskSnapshots();
  }

  function stopActivityTask(taskId: string): void {
    void controller.stopTask(taskId).then((cancelled) => {
      toasts.push({
        variant: cancelled ? "success" : "warning",
        title: cancelled ? "task stopped" : "task not stopped",
        message: taskId,
      });
      void refreshTaskSnapshots();
    });
  }

  function openActivity(tab?: ActivityTab): void {
    if (layers.has("activity") && !tab) {
      layers.pop("activity");
      return;
    }
    const nextTab =
      tab ?? (taskActivity.running > 0 ? "tasks" : lastActivityTab);
    setLastActivityTab(nextTab);
    if (nextTab === "tasks") void refreshTaskSnapshots();
    setLastSeenTaskSequence(
      taskActivity.tasks.reduce(
        (max, task) => Math.max(max, task.lastSequence),
        lastSeenTaskSequence,
      ),
    );
    layers.push("activity", { tab: nextTab });
  }

  function cyclePermissionMode(): void {
    const next = nextAllowedTuiPermissionMode(
      effTuiPermissionMode,
      resolved.accessModeCeiling,
    );
    const effectiveNext = clampTuiPermissionMode(
      resolved.accessModeCeiling,
      next,
    );
    setPermissionModeOverride(next);
    controller.updateTuiPermissionMode(effectiveNext);
    store.appendNotice(`permission -> ${effectiveNext} (next run)`);
  }

  function commitModelSelection(modelName: string): void {
    const nextModelName = modelName.trim() || "deterministic";
    const changed = nextModelName !== modelLabel;
    setModelOverride({ modelName: nextModelName });
    controller.updateModel(nextModelName, "request");
    // A committed switch leaves one permanent line in scrollback; no transient
    // toast on top of it (an unchanged pick just closes the dialog silently).
    if (changed) store.appendNotice(`model -> ${nextModelName} (next run)`);
    layers.pop("model");
  }

  const cols = resolveDialogColumns(stdout?.columns) ?? 100;
  // Only reserve the sidebar rail when the terminal is wide AND there's
  // something to show — an empty "modified files (none yet)" box pinned at the
  // bottom is just clutter.
  const hasSidebarContent = state.modifiedFiles.length > 0;
  const sidebarWidth = cols >= 100 && hasSidebarContent ? 32 : 0;

  // Cap the live stream panel so a long in-flight message can't push the input
  // off-screen. Committed lines are in scrollback, so nothing else is clamped.
  const streamingMax = Math.max(3, termRows - 16);

  function closeTopLayer(): void {
    if (!topLayer) return;
    layers.pop(topLayer.name);
    if (topLayer.name === "events") {
      toasts.push({ variant: "info", message: "closed events" });
    }
    if (topLayer.name === "session-rename") setRenameTarget(null);
  }

  if (topLayer?.name === "events") {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <LayerRenderer
            entry={topLayer}
            registry={registry}
            resolved={effectiveResolved}
            sessionList={sessionList}
            sessionRootLabel={resolved.sessionRootLabel}
            events={state.events}
            taskRecords={taskRecords}
            taskOutputs={taskOutputs}
            loadingTasks={loadingTasks}
            labels={labels}
            renameTarget={renameTarget}
            effModel={effModel}
            modelCandidates={modelCandidates(resolved.providers)}
            sessionDiagnostics={sessionDiagnostics}
            loadingDiagnosticsFor={loadingDiagnosticsFor}
            capabilitySnapshot={capabilitySnapshot}
            loadingCapabilities={loadingCapabilities}
            skillReviewSnapshot={skillReviewSnapshot}
            loadingSkillReview={loadingSkillReview}
            onActivityTabChange={handleActivityTabChange}
            onRefreshTasks={() => void refreshTaskSnapshots()}
            onStopTask={stopActivityTask}
            onCommitModel={commitModelSelection}
            onFork={(seq, label, edit) => {
              const src = state.sessionId;
              layers.pop("fork");
              if (!src) return;
              void controller.forkSession(src, seq).then((res) => {
                if (!res) return;
                void controller.switchSession(res.forkedSessionId);
                if (edit && label) inputHandleRef.current?.setValue(label);
                toasts.push({
                  variant: "success",
                  title: edit ? "forked — edit & resend" : "forked",
                  message: `${res.forkedSessionId} (${res.copiedEventCount} events copied)`,
                });
              });
            }}
            onCloseTop={closeTopLayer}
            onInspectSession={(id) => void inspectSession(id)}
            onPickSession={(id) => {
              void controller.switchSession(id);
              layers.pop("sessions");
              toasts.push({
                variant: "success",
                message: `switched to session ${id}`,
              });
            }}
            onRequestRename={(id) => {
              setRenameTarget(id);
              layers.push("session-rename");
            }}
            onCommitRename={(id, label) => {
              void labelsRef.current?.set(id, label).then(() => {
                setLabels(labelsRef.current?.get() ?? {});
                toasts.push({
                  variant: "success",
                  title: label ? "renamed" : "cleared",
                  message: id,
                });
              });
              layers.pop("session-rename");
              setRenameTarget(null);
            }}
            onApprovalDecision={(d) => controller.resolveApproval(d)}
            onCreateCapability={(draft) => void handleCreateCapability(draft)}
            onCreateSkillProposal={handleCreateSkillProposal}
            onUpdateSkillProposal={handleUpdateSkillProposal}
            onApplySkillReviewProposal={applySkillReviewProposal}
            onRejectSkillReviewProposal={rejectSkillReviewProposal}
          />
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <Box flexDirection="column">
        {isRawModeSupported ? <Hotkeys /> : null}

        {/* Committed transcript → terminal scrollback, led by a one-time session
          header at the top. Keyed on clearGeneration so /clear and /new remount
          it (paired with the screen wipe above), reprinting a fresh header. */}
        <EventStream
          key={state.clearGeneration}
          events={state.events}
          header={{
            workspaceRoot: resolved.workspaceRoot,
            modelLabel,
            sessionId: state.sessionId,
          }}
        />

        {/* Live frame: pinned below the scrollback. The status line only shows
          while there's active work to watch — idle/done/error leave just the
          input (run completion/failure already surfaces as a toast, and a
          /model switch leaves a scrollback line). */}
        {state.status === "running" ||
        state.status === "awaiting-approval" ||
        taskActivity.running > 0 ||
        unreadTaskCount > 0 ? (
          <StatusBar
            state={state}
            modelLabel={modelLabel}
            permissionMode={effTuiPermissionMode}
            focused={focused}
            unreadCompletedTasks={Math.max(
              0,
              unreadTaskCount - unreadFailedTaskCount,
            )}
            unreadFailedTasks={unreadFailedTaskCount}
          />
        ) : null}

        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1}>
            {/* The streamed answer itself. The "what phase am I in" hint is not
              a second spinner line here — it rides the StatusBar label above
              (e.g. "thinking" / "running shell" / "agent reviewer") so there's
              one spinner, not two competing ones. */}
            {state.streamingText || state.reasoningText ? (
              <StreamingMessage
                text={state.streamingText}
                reasoning={state.reasoningText}
                maxLines={streamingMax}
              />
            ) : null}
          </Box>
          {sidebarWidth > 0 ? (
            <Sidebar files={state.modifiedFiles} width={sidebarWidth} />
          ) : null}
        </Box>

        {/* Todo ledger as a full-width band, pinned above the input. Shown
          while a run is active, and also kept after it ends when items remain
          unfinished — so a handoff's residual pending/in_progress stays visible
          instead of vanishing the moment the run stops. Collapses to a single
          line while the model streams a long answer so it does not dominate the
          frame. */}
        {state.todoItems.length > 0 &&
        (state.status === "running" ||
          state.status === "awaiting-approval" ||
          state.todoItems.some((t) => t.status !== "completed")) ? (
          <TodoBand
            todos={state.todoItems}
            width={cols}
            compact={Boolean(state.streamingText)}
            expanded={todoExpanded}
          />
        ) : null}

        {state.status !== "running" &&
        state.status !== "awaiting-approval" &&
        state.usage ? (
          <UsageSummaryLine usage={state.usage} />
        ) : null}

        {state.lastError ? (
          <Box paddingX={1}>
            <Text color={theme.error}>error: {state.lastError}</Text>
          </Box>
        ) : null}

        <ToastView
          toast={toastSnapshot.current}
          queueDepth={toastSnapshot.queueDepth}
        />

        {resolved.errors.length > 0 ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="red"
            paddingX={1}
          >
            <Text color="red" bold>
              config errors ({resolved.errors.length})
            </Text>
            {resolved.errors.map((e, i) => (
              <Text key={`${e.file}:${e.field}:${i}`}>
                <Text dimColor>{e.file}</Text>
                <Text> </Text>
                <Text color="red">{e.field}</Text>
                <Text> </Text>
                <Text>{e.message}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {/* Prompts queued during an in-flight run, shown above the input. */}
        {!topLayer ? <QueuedMessages items={queued} /> : null}

        {/* Layer rendering — only the topmost layer owns input. */}
        {topLayer ? (
          <LayerRenderer
            entry={topLayer}
            registry={registry}
            resolved={effectiveResolved}
            sessionList={sessionList}
            sessionRootLabel={resolved.sessionRootLabel}
            events={state.events}
            taskRecords={taskRecords}
            taskOutputs={taskOutputs}
            loadingTasks={loadingTasks}
            labels={labels}
            renameTarget={renameTarget}
            effModel={effModel}
            modelCandidates={modelCandidates(resolved.providers)}
            sessionDiagnostics={sessionDiagnostics}
            loadingDiagnosticsFor={loadingDiagnosticsFor}
            capabilitySnapshot={capabilitySnapshot}
            loadingCapabilities={loadingCapabilities}
            skillReviewSnapshot={skillReviewSnapshot}
            loadingSkillReview={loadingSkillReview}
            onActivityTabChange={handleActivityTabChange}
            onRefreshTasks={() => void refreshTaskSnapshots()}
            onStopTask={stopActivityTask}
            onCommitModel={commitModelSelection}
            onFork={(seq, label, edit) => {
              const src = state.sessionId;
              layers.pop("fork");
              if (!src) return;
              void controller.forkSession(src, seq).then((res) => {
                if (!res) return;
                // Switch to the fork AND load its (copied) history so the
                // branched conversation is visible, not a blank screen.
                void controller.switchSession(res.forkedSessionId);
                if (edit && label) inputHandleRef.current?.setValue(label);
                toasts.push({
                  variant: "success",
                  title: edit ? "forked — edit & resend" : "forked",
                  message: `${res.forkedSessionId} (${res.copiedEventCount} events copied)`,
                });
              });
            }}
            onCloseTop={() => {
              closeTopLayer();
            }}
            onInspectSession={(id) => void inspectSession(id)}
            onPickSession={(id) => {
              void controller.switchSession(id);
              layers.pop("sessions");
              toasts.push({
                variant: "success",
                message: `switched to session ${id}`,
              });
            }}
            onRequestRename={(id) => {
              setRenameTarget(id);
              layers.push("session-rename");
            }}
            onCommitRename={(id, label) => {
              void labelsRef.current?.set(id, label).then(() => {
                setLabels(labelsRef.current?.get() ?? {});
                toasts.push({
                  variant: "success",
                  title: label ? "renamed" : "cleared",
                  message: id,
                });
              });
              layers.pop("session-rename");
              setRenameTarget(null);
            }}
            onApprovalDecision={(d) => controller.resolveApproval(d)}
            onCreateCapability={(draft) => void handleCreateCapability(draft)}
            onCreateSkillProposal={handleCreateSkillProposal}
            onUpdateSkillProposal={handleUpdateSkillProposal}
            onApplySkillReviewProposal={applySkillReviewProposal}
            onRejectSkillReviewProposal={rejectSkillReviewProposal}
          />
        ) : isRawModeSupported ? (
          <InputBox
            // Stay editable while a run is in flight: submissions are queued
            // (see handleSubmit) rather than blocked, so the user can line up
            // follow-ups without waiting.
            disabled={false}
            placeholder={
              state.status === "running" || state.status === "awaiting-approval"
                ? "running — type to queue the next goal (esc cancels run)"
                : 'type a goal, /capabilities for available capabilities, or "/" for commands'
            }
            workspaceRoot={resolved.workspaceRoot}
            registry={registry}
            vim={resolved.vim}
            onSubmit={handleSubmit}
            onCommand={(cmd, rest) =>
              void (cmd.runRaw ? cmd.runRaw(rest) : cmd.run())
            }
            onEscape={() => {
              // Esc cancels an in-flight run (the placeholder promises this). The
              // App-level hotkey loop also binds cancel.run→esc, but it lives in a
              // remounted inline component whose useInput drops the key mid-stream;
              // InputBox is stable, so this is the reliable path.
              if (state.status === "running") {
                if (controller.cancel())
                  toasts.push({ variant: "info", message: "cancelling…" });
              }
            }}
            onQuit={requestQuit}
            onQuitClear={noteInputClearedByQuit}
            stashRef={stashRef}
            onStashChange={(next) => {
              stashRef.current = next;
            }}
            handleRef={inputHandleRef}
          />
        ) : (
          <Box paddingX={1}>
            <Text dimColor>
              (input disabled — stdin is not a TTY; run from a real terminal)
            </Text>
          </Box>
        )}

        <Box paddingX={1} flexDirection="column">
          {inputFooterLines(resolved.bindings, cols - 2).map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    </ThemeProvider>
  );
}

function runIdsFromEvents(events: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of events) {
    const id = runIdFromEvent(event);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function runIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  if (typeof record.runId === "string") return record.runId;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const payloadRecord = payload as Record<string, unknown>;
  return typeof payloadRecord.runId === "string"
    ? payloadRecord.runId
    : undefined;
}

function mergeTaskRecords(
  records: readonly TaskRecordSnapshot[],
): TaskRecordSnapshot[] {
  const byId = new Map<string, TaskRecordSnapshot>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) =>
    taskRecordSortTime(b).localeCompare(taskRecordSortTime(a)),
  );
}

function taskRecordSortTime(task: TaskRecordSnapshot): string {
  return (
    task.completedAt ??
    task.lastOutputAt ??
    task.startedAt ??
    task.createdAt ??
    ""
  );
}

export function inputFooterLines(bindings: Bindings, width = 100): string[] {
  const items = ["enter run", "\\↵ newline", "/ commands", "@ files"];
  for (const [name, label] of [
    ["cycle-permission-mode", "mode"],
    ["history.search", "search"],
    ["activity.open", "activity"],
    ["events.open", "inspector"],
    ["cancel.run", "cancel"],
    ["quit.app", "quit x2"],
  ] as const) {
    const binding = formatBinding(bindings[name]);
    if (binding) items.push(`${binding} ${label}`);
  }
  return wrapFooterItems(items, Math.max(24, width));
}

function wrapFooterItems(items: string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current ? `${current} · ${item}` : item;
    if (next.length <= width || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = item;
  }
  if (current) lines.push(current);
  return lines;
}
