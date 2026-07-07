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
import type { Key } from "ink";
import { EventStore } from "./state/event-store.js";
import { RunController } from "./state/run-controller.js";
import { ToastStore } from "./state/toast-store.js";
import { QueueStore } from "./state/queue-store.js";
import { LayerStack } from "./state/layer-stack.js";
import { EventStream } from "./components/event-stream.js";
import { InputBox } from "./components/input-box.js";
import { StreamingMessage } from "./components/streaming-message.js";
import { ToastView } from "./components/toast.js";
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
import { AttentionManager } from "./lib/attention.js";
import {
  useSkillActions,
  runSkillLearnAutoNotice,
} from "./state/use-skill-actions.js";
import { useCapabilityActions } from "./state/use-capability-actions.js";
import { useSessionActions } from "./state/use-session-actions.js";
import { useTaskActions } from "./state/use-task-actions.js";
import { buildCommandRegistry } from "./state/build-command-registry.js";
import type { ProjectCommandDescriptor } from "@sparkwright/project-commands";
import {
  loadProjectCommands,
  resolveProjectCommandIntent,
} from "./lib/project-commands.js";
import {
  chordMatches,
  ctrlCPressCount,
  DEFAULTS as DEFAULT_BINDINGS,
  type Bindings,
} from "./lib/keybindings.js";
import type { PermissionMode, TraceLevel } from "@sparkwright/protocol";
import {
  loadTuiConfig,
  watchTuiConfig,
  type LoadedTuiConfig,
  type SourceMap,
  type TuiConfigFile,
  type ValidationError,
} from "./lib/config.js";
import {
  clampTuiPermissionMode,
  nextAllowedTuiPermissionMode,
  toCoreRunFields,
  type TuiPermissionMode,
} from "./lib/permission.js";

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
  const theme = resolved.theme;
  // Todo band: collapsed by default (active items only); ctrl+t expands to show
  // completed items too.
  const [todoExpanded, setTodoExpanded] = useState(false);
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
        // Errors have a single, persistent surface: the pinned red line below
        // the stream (kept until the next run clears state.lastError). We only
        // ring the bell here — no error toast on top of that line, which was
        // the redundant double-surface.
        attention.notify("run failed");
      } else {
        const cancelledRun =
          state.stopReason === "manual_cancelled" ||
          state.stopReason === "user_cancelled";
        attention.notify(cancelledRun ? "run cancelled" : "run done");
        toasts.push({
          variant: cancelledRun ? "info" : "success",
          title: cancelledRun ? "run cancelled" : "run done",
          message: cancelledRun
            ? "cancelled"
            : (state.stopReason ?? "completed"),
        });
        runSkillLearnAutoNotice({
          workspaceRoot: resolved.workspaceRoot,
          toasts,
          goals: skillLearnGoalsRef.current,
          sessionId: state.sessionId,
          noticeCount: skillLearnNoticeCountRef.current,
          setNoticeCount: (n) => {
            skillLearnNoticeCountRef.current = n;
          },
        });
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

  // Skill Evolution actions + the review-panel state they drive live in a
  // dedicated hook so App carries the wiring, not the proposal/review/learn
  // toast plumbing.
  const skillActions = useSkillActions({
    workspaceRoot: resolved.workspaceRoot,
    toasts,
    layers,
    reloadConfig,
  });

  // Capability browser + creation flow (panel snapshot state + handlers).
  const capActions = useCapabilityActions({
    workspaceRoot: resolved.workspaceRoot,
    controller,
    toasts,
    layers,
  });

  // Session browsing / diagnostics / labels / rename / fork / export.
  const sessionActions = useSessionActions({
    workspaceRoot: resolved.workspaceRoot,
    sessionId: state.sessionId,
    controller,
    store,
    toasts,
    layers,
    inputHandleRef,
  });

  // Background-task activity: snapshots, unread counts, and drawer handlers.
  const taskActions = useTaskActions({
    controller,
    toasts,
    layers,
    events: state.events,
  });

  useEffect(() => {
    const dispose = watchTuiConfig(props.initialCwd, () => {
      void reloadConfig(true);
    });
    return dispose;
  }, [props.initialCwd]);

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

  // Build the slash-command registry from the extracted builder. App-level
  // handlers are closed over via the deps object and invoked later via slash
  // input. Re-build when keybindings change so hint strings refresh, when the
  // current session id changes so /rename targets the right session, and when
  // project-authored commands are reloaded.
  const registry = useMemo(
    () =>
      buildCommandRegistry({
        bindings: resolved.bindings,
        layers,
        store,
        controller,
        toasts,
        exit,
        skillActions,
        capActions,
        sessionActions,
        taskActions,
        projectCommands,
        runProjectCommand,
      }),
    [
      layers,
      controller,
      toasts,
      state.sessionId,
      resolved.bindings,
      resolved.workspaceRoot,
      projectCommands,
    ],
  );

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
  //
  // This is only the per-render closure; the `useInput` listener lives in the
  // module-scope `HotkeysListener` below. Keeping the listener component's
  // identity stable across renders is deliberate — a component defined inline
  // in App is a fresh type each render, so Ink unmounts/remounts it every time
  // and its `useInput` can drop a keystroke mid-stream.
  function handleHotkey(input: string, key: Key): void {
    const b = resolved.bindings;
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
      taskActions.openActivity();
      return;
    }
    if (!top && b["events.open"].some((c) => chordMatches(c, key, input))) {
      taskActions.openActivity("events");
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
  }

  const modelLabel = effModel ?? "deterministic";

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
    if (topLayer.name === "session-rename")
      sessionActions.setRenameTarget(null);
  }

  // Props shared by both LayerRenderer mount points — the full-screen `events`
  // drawer (early return below) and the inline layer above the input. Assembled
  // once so the two call sites can't drift apart. `entry` is supplied per call
  // site (both currently pass `topLayer`).
  const layerProps = {
    registry,
    bindings: resolved.bindings,
    resolved: effectiveResolved,
    sessionList: sessionActions.sessionList,
    sessionRootLabel: resolved.sessionRootLabel,
    events: state.events,
    taskRecords: taskActions.taskRecords,
    taskOutputs: taskActions.taskOutputs,
    loadingTasks: taskActions.loadingTasks,
    labels: sessionActions.labels,
    renameTarget: sessionActions.renameTarget,
    effModel,
    modelCandidates: modelCandidates(resolved.providers),
    sessionDiagnostics: sessionActions.sessionDiagnostics,
    loadingDiagnosticsFor: sessionActions.loadingDiagnosticsFor,
    capabilitySnapshot: capActions.capabilitySnapshot,
    loadingCapabilities: capActions.loadingCapabilities,
    skillReviewSnapshot: skillActions.skillReviewSnapshot,
    loadingSkillReview: skillActions.loadingSkillReview,
    onActivityTabChange: taskActions.handleActivityTabChange,
    onRefreshTasks: () => void taskActions.refreshTaskSnapshots(),
    onStopTask: taskActions.stopActivityTask,
    onJoinTask: taskActions.joinActivityTask,
    onPromoteTask: taskActions.promoteActivityTask,
    onCommitModel: commitModelSelection,
    onFork: sessionActions.forkSession,
    onCloseTop: closeTopLayer,
    onInspectSession: (id: string) => void sessionActions.inspectSession(id),
    onPickSession: sessionActions.pickSession,
    onRequestRename: sessionActions.requestRename,
    onCommitRename: sessionActions.commitRename,
    onApprovalDecision: (d: "approved" | "denied") =>
      controller.resolveApproval(d),
    onCreateCapability: capActions.handleCreateCapability,
    onCreateSkillProposal: skillActions.handleCreateSkillProposal,
    onUpdateSkillProposal: skillActions.handleUpdateSkillProposal,
    onApplySkillReviewProposal: skillActions.applySkillReviewProposal,
    onRejectSkillReviewProposal: skillActions.rejectSkillReviewProposal,
  } satisfies Omit<React.ComponentProps<typeof LayerRenderer>, "entry">;

  if (topLayer?.name === "events") {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <LayerRenderer entry={topLayer} {...layerProps} />
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <Box flexDirection="column">
        {isRawModeSupported ? <HotkeysListener onInput={handleHotkey} /> : null}

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
        taskActions.taskActivity.running > 0 ||
        taskActions.unreadTaskCount > 0 ? (
          <StatusBar
            state={state}
            modelLabel={modelLabel}
            permissionMode={effTuiPermissionMode}
            focused={focused}
            unreadCompletedTasks={Math.max(
              0,
              taskActions.unreadTaskCount - taskActions.unreadFailedTaskCount,
            )}
            unreadFailedTasks={taskActions.unreadFailedTaskCount}
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
          <LayerRenderer entry={topLayer} {...layerProps} />
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
      </Box>
    </ThemeProvider>
  );
}

/**
 * Stable listener for App-level hotkeys. Defined at module scope so its type
 * identity never changes across App renders — a component defined inline in App
 * is a fresh type each render, so Ink unmounts/remounts it every time and its
 * `useInput` can drop a keystroke mid-stream. Only the `onInput` closure changes
 * per render, which Ink handles fine (same pattern as InputBox).
 */
function HotkeysListener(props: {
  onInput: (input: string, key: Key) => void;
}): null {
  useInput((input, key) => props.onInput(input, key));
  return null;
}
