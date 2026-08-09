import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { join } from "node:path";
import { Box, Text, useApp, useStdin, useStdout } from "ink";
import type { Key } from "ink";
import { EventStore } from "./state/event-store.js";
import { RunController } from "./state/run-controller.js";
import { NotificationStore } from "./state/notification-store.js";
import { QueueStore } from "./state/queue-store.js";
import { LayerStack } from "./state/layer-stack.js";
import { InputBox } from "./components/input-box.js";
import { ThemeProvider } from "./lib/theme-context.js";
import { resolveTheme, type Theme } from "./lib/theme.js";
import { loadStash, type StashFile } from "./lib/stash.js";
import type { InputBoxHandle } from "./components/input-box.js";
import { LiveFrame } from "./components/live-frame.js";
import { resolveStreamingAnswerRows } from "./components/streaming-message.js";
import { LayerRenderer } from "./components/layer-renderer.js";
import { TranscriptViewport } from "./components/transcript-viewport.js";
import { TranscriptBrowseFooter } from "./components/transcript-browse-footer.js";
import { resolveDialogColumns } from "./components/dialog-frame.js";
import { AttentionManager } from "./lib/attention.js";
import { presentationPolicy } from "./lib/ui-signal.js";
import { useCapabilityActions } from "./state/use-capability-actions.js";
import { useSessionActions } from "./state/use-session-actions.js";
import { useTaskActions } from "./state/use-task-actions.js";
import { useWorkflowActions } from "./state/use-workflow-actions.js";
import { buildCommandRegistry } from "./state/build-command-registry.js";
import type { ProjectCommandDescriptor } from "@sparkwright/project-commands";
import { loadProjectCommands } from "./lib/project-commands.js";
import {
  DEFAULTS as DEFAULT_BINDINGS,
  isPlainEscapeChord,
  type Bindings,
} from "./lib/keybindings.js";
import {
  InteractionRouter,
  type InteractionAction,
} from "./lib/interaction-router.js";
import type {
  PermissionMode,
  ProviderCatalogSnapshot,
  ProjectCommandReference,
  ProjectTrustSnapshot,
  TraceLevel,
} from "@sparkwright/protocol";
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
import { assembleTranscriptDocument } from "./lib/transcript-document.js";
import { layoutTranscriptDocument } from "./lib/transcript-layout.js";
import { inkScreenRows } from "./lib/terminal-screen-layout.js";
import {
  EMPTY_MODEL_PREFERENCES,
  loadModelPreferences,
  type ModelPreferences,
} from "./lib/model-preferences.js";
import {
  initialTranscriptViewportState,
  moveTranscriptViewportToEnd,
  moveTranscriptViewportToStart,
  resetTranscriptViewport,
  scrollTranscriptViewport,
  synchronizeTranscriptViewport,
  toggleTranscriptViewportMode,
} from "./state/transcript-viewport-state.js";

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
    const legacyIds = Object.keys(provider.models ?? {});
    const modelIds =
      legacyIds.length > 0
        ? legacyIds
        : (provider.modelPolicy?.allow ??
          Object.keys(provider.modelOverrides ?? {}));
    const denied = new Set(provider.modelPolicy?.deny ?? []);
    for (const modelId of modelIds) {
      if (denied.has(modelId)) continue;
      refs.push(`${providerKey}/${modelId}`);
    }
  }
  return refs;
}

export function App(props: AppProps): React.ReactElement {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    let cancelled = false;
    const configRoot = props.cliOverrides.workspaceRoot ?? props.initialCwd;
    void loadTuiConfig(configRoot).then((loaded) => {
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
  const { stdout } = useStdout();
  const { resolved } = props;

  const store = useMemo(() => new EventStore(), []);
  const layers = useMemo(() => new LayerStack(), []);
  const toasts = useMemo(() => new NotificationStore(), []);
  const queue = useMemo(() => new QueueStore(), []);
  const attention = useMemo(() => new AttentionManager(), []);
  const interactionRouter = useMemo(() => new InteractionRouter(), []);
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
        signals: toasts,
      }),
    [resolved.workspaceRoot, resolved.sessionRootDir, store, toasts],
  );
  const initialSessionLoadedRef = useRef(false);

  useEffect(() => {
    const initialSessionId = props.cliOverrides.sessionId;
    if (!initialSessionId || initialSessionLoadedRef.current) return;
    initialSessionLoadedRef.current = true;
    void controller.switchSession(initialSessionId);
  }, [controller, props.cliOverrides.sessionId]);

  // The app owns a fixed-height screen. Transcript layout uses physical rows;
  // live state and the composer occupy the reserved lower frame.
  const [termRows, setTermRows] = useState<number>(
    Math.max(1, stdout?.rows ?? 24),
  );
  const screenRows = inkScreenRows(termRows);
  const [liveFrameRows, setLiveFrameRows] = useState(0);
  const [inputFrameRows, setInputFrameRows] = useState(3);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setTermRows(Math.max(1, stdout.rows ?? 24));
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
  const [transcriptViewport, setTranscriptViewport] = useState(
    initialTranscriptViewportState,
  );
  // Prompt stash bridge — the InputBox reads/writes through this ref.
  const stashRef = useRef<StashFile>({ current: null, list: [] });
  const inputDraftRef = useRef("");
  const inputHandleRef = useRef<InputBoxHandle | null>(null);
  // Runtime model-ref override from /model; falls back to config.
  const [modelOverride, setModelOverride] = useState<{
    modelName?: string;
  } | null>(null);
  const effModel = modelOverride ? modelOverride.modelName : resolved.modelName;
  const [providerCatalog, setProviderCatalog] =
    useState<ProviderCatalogSnapshot | null>(null);
  const modelPreferencesRef = useRef<ModelPreferences | null>(null);
  const [modelPreferences, setModelPreferences] = useState(
    EMPTY_MODEL_PREFERENCES,
  );
  useEffect(() => {
    let active = true;
    void loadModelPreferences().then((preferences) => {
      if (!active) return;
      modelPreferencesRef.current = preferences;
      setModelPreferences(preferences.snapshot());
    });
    return () => {
      active = false;
    };
  }, []);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustSnapshot | null>(
    null,
  );
  const [loadingProjectTrust, setLoadingProjectTrust] = useState(false);
  useEffect(() => {
    if (topLayer?.name !== "model" && topLayer?.name !== "connect") return;
    let cancelled = false;
    const projection = topLayer.name === "connect" ? "all" : "available";
    const load = async () => {
      const catalog = await controller.listProviders(effModel, projection);
      if (cancelled) return;
      setProviderCatalog(catalog);
      setLoadingProviders(false);
    };
    setLoadingProviders(true);
    void load();
    const poll = setInterval(() => void load(), 1_000);
    poll.unref?.();
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [controller, effModel, topLayer?.name]);
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
    const unsubSignals = toasts.onSignal((signal) => {
      if (signal.attention === "blurred") {
        attention.notify(
          signal.title ? `${signal.title}: ${signal.message}` : signal.message,
          signal.dedupeKey ?? signal.id,
        );
      }
    });
    return () => {
      unsub();
      unsubSignals();
      attention.disable();
    };
  }, [attention, toasts]);

  // /clear, /new, and session switches create a new document epoch. The export
  // buffer remains owned by RunController; only the viewport anchor resets.
  const lastDocumentEpoch = useRef(
    `${state.sessionId ?? "no-session"}:${state.clearGeneration}`,
  );
  useEffect(() => {
    const epoch = `${state.sessionId ?? "no-session"}:${state.clearGeneration}`;
    if (epoch === lastDocumentEpoch.current) return;
    lastDocumentEpoch.current = epoch;
    setTranscriptViewport((current) => resetTranscriptViewport(current));
  }, [state.clearGeneration, state.sessionId]);

  // Project blocking approvals into the unified signal policy. The decision
  // surface remains canonical for action; the signal owns attention/history.
  const lastApprovalId = useRef<string | null>(null);
  useEffect(() => {
    if (
      state.pendingApproval &&
      state.pendingApproval.approvalId !== lastApprovalId.current
    ) {
      if (lastApprovalId.current) {
        toasts.resolve(`approval:${lastApprovalId.current}`);
      }
      lastApprovalId.current = state.pendingApproval.approvalId;
      const kind = "blocking" as const;
      const scope = "Approval" as const;
      toasts.publish({
        kind,
        scope,
        source: "tui.approval",
        title: "approval needed",
        message: state.pendingApproval.summary,
        dedupeKey: `approval:${state.pendingApproval.approvalId}`,
        actions: [
          { id: "allow-once", label: "Allow once", key: "y" },
          { id: "deny", label: "Deny", key: "esc" },
        ],
        ...presentationPolicy({ kind, scope }),
      });
    } else if (!state.pendingApproval) {
      if (lastApprovalId.current) {
        toasts.resolve(`approval:${lastApprovalId.current}`);
      }
      lastApprovalId.current = null;
    }
  }, [state.pendingApproval, toasts]);

  const lastDiagnosticId = useRef<string | null>(null);
  useEffect(() => {
    const diagnostic = state.lastDiagnostic;
    if (!diagnostic) {
      if (lastDiagnosticId.current) {
        toasts.resolve(lastDiagnosticId.current);
        lastDiagnosticId.current = null;
      }
      return;
    }
    if (diagnostic.id === lastDiagnosticId.current) return;
    if (lastDiagnosticId.current) toasts.resolve(lastDiagnosticId.current);
    lastDiagnosticId.current = diagnostic.id;
    const kind = "error" as const;
    const scope = diagnostic.scope;
    toasts.publish({
      id: diagnostic.id,
      kind,
      scope,
      source: "tui.run",
      title: diagnostic.title,
      message: diagnostic.message,
      dedupeKey: diagnostic.id,
      ...presentationPolicy({ kind, scope }),
    });
  }, [state.lastDiagnostic, toasts]);

  useEffect(() => {
    const dedupeKey = "config:validation";
    if (resolved.errors.length === 0) {
      toasts.resolve(dedupeKey);
      return;
    }
    const kind = "error" as const;
    const scope = "Config" as const;
    toasts.publish({
      kind,
      scope,
      source: "tui.config",
      title: "config errors",
      message: `${resolved.errors.length} validation error(s) · /config for details`,
      details: resolved.errors,
      dedupeKey,
      ...presentationPolicy({ kind, scope }),
    });
  }, [resolved.errors, toasts]);

  async function reloadConfig(verbose: boolean): Promise<void> {
    const configRoot = props.cliOverrides.workspaceRoot ?? props.initialCwd;
    const loaded = await loadTuiConfig(configRoot);
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
    sessionId: state.sessionId ?? controller.getSessionId(),
  });

  const workflowActions = useWorkflowActions({
    controller,
    store,
    toasts,
    layers,
    layerOpen: layerSnapshot.some((layer) => layer.name === "workflow"),
    enableBackgroundRefresh: isRawModeSupported,
  });

  useEffect(() => {
    if (isRawModeSupported) return;
    const id = setTimeout(() => exit(), 0);
    return () => clearTimeout(id);
  }, [exit, isRawModeSupported]);

  useEffect(() => {
    if (!isRawModeSupported) return;
    const configRoot = props.cliOverrides.workspaceRoot ?? props.initialCwd;
    const dispose = watchTuiConfig(configRoot, () => {
      void reloadConfig(true);
    });
    return dispose;
  }, [isRawModeSupported, props.initialCwd]);

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

  const projectSubmitRef = useRef<
    (goal: string, command: ProjectCommandReference) => void
  >(() => {});
  useEffect(() => {
    projectSubmitRef.current = submitProjectCommand;
  });

  function runProjectCommand(
    descriptor: ProjectCommandDescriptor,
    rest: string,
  ): void {
    void (async () => {
      if (descriptor.source === "project") {
        const snapshot =
          projectTrust ?? (await controller.inspectProjectTrust());
        if (snapshot) setProjectTrust(snapshot);
        const commandsTrusted = snapshot?.scopes.some(
          (scope) =>
            scope.scope === "commands" &&
            (scope.status === "trusted" || scope.status === "not_present"),
        );
        if (!commandsTrusted) {
          layers.push("trust");
          toasts.push({
            variant: "warning",
            title: "project trust required",
            message: `review /${descriptor.name} capability trust, then run it again`,
          });
          return;
        }
      }
      const trimmedRest = rest.trim();
      const goal = `/${descriptor.name}${trimmedRest ? ` ${trimmedRest}` : ""}`;
      projectSubmitRef.current(goal, {
        name: descriptor.name,
        ...(trimmedRest ? { rest: trimmedRest } : {}),
      });
    })();
  }

  function openProjectTrust(): void {
    layers.push("trust");
    setLoadingProjectTrust(true);
    void controller.inspectProjectTrust().then((snapshot) => {
      if (snapshot) setProjectTrust(snapshot);
      setLoadingProjectTrust(false);
    });
  }

  function grantProjectTrust(expectedManifestHash: string): void {
    setLoadingProjectTrust(true);
    void controller
      .grantProjectTrust(expectedManifestHash)
      .then(async (snapshot) => {
        if (snapshot) {
          setProjectTrust(snapshot);
          store.appendNotice(`project trust -> ${snapshot.status}`);
          await reloadConfig(false);
        }
        setLoadingProjectTrust(false);
      });
  }

  function revokeProjectTrust(): void {
    setLoadingProjectTrust(true);
    void controller.revokeProjectTrust().then(async (snapshot) => {
      if (snapshot) {
        setProjectTrust(snapshot);
        store.appendNotice(`project trust -> ${snapshot.status}`);
        await reloadConfig(false);
      }
      setLoadingProjectTrust(false);
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
        capActions,
        sessionActions,
        taskActions,
        workflowActions,
        projectCommands,
        runProjectCommand,
        submitFollowUp,
        openProjectTrust,
      }),
    [
      layers,
      controller,
      toasts,
      state.sessionId,
      state.status,
      resolved.bindings,
      resolved.workspaceRoot,
      projectCommands,
      projectTrust,
      workflowActions,
    ],
  );

  function startGoal(
    value: string,
    projectCommand?: ProjectCommandReference,
  ): void {
    quitArmedUntilRef.current = 0;
    void controller.start(
      value,
      projectCommand ? { projectCommand } : undefined,
    );
  }

  function submitFollowUp(value: string): void {
    const goal = value.trim();
    if (!goal) {
      toasts.push({
        variant: "info",
        title: "follow-up",
        message: "usage: /followup <goal>",
      });
      return;
    }
    if (state.status !== "running" && state.status !== "awaiting-approval") {
      startGoal(goal);
      return;
    }
    void controller.followUp(goal).then((commandId) => {
      if (commandId) {
        queue.enqueueSubmission({ goal, commandId });
        return;
      }
      queue.enqueue(goal);
    });
  }

  function submitProjectCommand(
    goal: string,
    projectCommand: ProjectCommandReference,
  ): void {
    if (state.status === "running" || state.status === "awaiting-approval") {
      queue.enqueueSubmission({ goal, projectCommand });
      return;
    }
    startGoal(goal, projectCommand);
  }

  function handleSubmit(value: string): void {
    // Plain Enter steers the active run at the next safe turn boundary. If the
    // terminal boundary wins the race, preserve the input as a local follow-up.
    if (state.status === "running" || state.status === "awaiting-approval") {
      void controller.steer(value).then((commandId) => {
        if (!commandId) queue.enqueue(value);
      });
      return;
    }
    if (state.stopReason === "manual_cancelled" && queued.length > 0) {
      // Composer queue is rendered in-place; no duplicate toast.
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
      controller.cancel();
      return;
    }
    if (topLayer?.name === "approval" && state.pendingApproval) {
      quitArmedUntilRef.current = now + 1500;
      void controller.resolveApproval("deny");
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
    const next = queue.dequeueLocalSubmission();
    if (next) startGoal(next.goal, next.projectCommand);
  }, [state.status, state.stopReason, queued.length, controller, queue]);

  useEffect(
    () =>
      controller.subscribeFollowUpUpdates((event) => {
        queue.removeByCommandId(event.payload.commandId);
        if (event.payload.status === "rejected") {
          toasts.push({
            variant: "warning",
            title: "follow-up rejected",
            message: event.payload.message ?? "the queued run did not start",
          });
        }
      }),
    [controller, queue, toasts],
  );

  function requestCancelRun(): void {
    controller.cancel();
  }

  const modelLabel = effModel ?? "deterministic";
  const cols = resolveDialogColumns(stdout?.columns) ?? 100;
  const documentEpoch = `${state.sessionId ?? "no-session"}:${state.clearGeneration}`;
  const frozenHeaderRef = useRef<{
    epoch: string;
    value: {
      workspaceRoot: string;
      modelLabel: string;
      sessionId: string | null;
    };
  } | null>(null);
  if (frozenHeaderRef.current?.epoch !== documentEpoch) {
    frozenHeaderRef.current = {
      epoch: documentEpoch,
      value: {
        workspaceRoot: resolved.workspaceRoot,
        modelLabel,
        sessionId: state.sessionId,
      },
    };
  }
  const frozenHeader = frozenHeaderRef.current.value;
  const transcriptDocument = useMemo(
    () =>
      assembleTranscriptDocument({
        epoch: documentEpoch,
        events: state.events,
        todoItems: state.todoItems,
        header: frozenHeader,
      }),
    [documentEpoch, frozenHeader, state.events, state.todoItems],
  );
  const inputSurfaceRows =
    transcriptViewport.mode === "detailed" ? 1 : inputFrameRows;
  const transcriptRows = Math.max(
    1,
    screenRows - liveFrameRows - inputSurfaceRows,
  );
  const transcriptLayout = useMemo(
    () =>
      layoutTranscriptDocument(
        transcriptDocument,
        transcriptViewport.mode,
        Math.max(1, cols - 2),
      ),
    [transcriptDocument, transcriptViewport.mode, cols],
  );
  const previousLayoutRef = useRef<{
    epoch: string;
    mode: typeof transcriptViewport.mode;
    columns: number;
    totalRows: number;
  } | null>(null);
  useEffect(() => {
    const previous = previousLayoutRef.current;
    const comparable =
      previous?.epoch === transcriptLayout.documentEpoch &&
      previous.mode === transcriptLayout.mode &&
      previous.columns === transcriptLayout.columns;
    if (comparable) {
      const appendedRows = Math.max(
        0,
        transcriptLayout.totalRows - previous.totalRows,
      );
      setTranscriptViewport((current) =>
        synchronizeTranscriptViewport(
          current,
          transcriptLayout,
          transcriptRows,
          appendedRows,
        ),
      );
    }
    previousLayoutRef.current = {
      epoch: transcriptLayout.documentEpoch,
      mode: transcriptLayout.mode,
      columns: transcriptLayout.columns,
      totalRows: transcriptLayout.totalRows,
    };
  }, [transcriptLayout, transcriptRows]);

  function toggleTranscriptDetails(): void {
    setTranscriptViewport((current) =>
      toggleTranscriptViewportMode(current, transcriptLayout, transcriptRows),
    );
  }

  function scrollTranscriptBy(delta: number): void {
    setTranscriptViewport((current) =>
      scrollTranscriptViewport(
        current,
        transcriptLayout,
        transcriptRows,
        delta,
      ),
    );
  }

  function routeGlobalInput(input: string, key: Key, draft: string): boolean {
    const b = resolved.bindings;
    const actions: InteractionAction[] = [
      {
        id: "quit.app",
        scope: "global",
        chords: b["quit.app"],
        enabled: true,
        run: () => requestQuit(),
      },
      {
        id: "activity.open",
        scope: "global",
        chords: b["activity.open"],
        enabled: true,
        run: () => taskActions.openActivity(),
      },
      {
        id: "events.open",
        scope: "global",
        chords: b["events.open"],
        enabled: true,
        run: () => taskActions.openActivity("events"),
      },
      {
        id: "help.open",
        scope: "global",
        chords: b["help.open"],
        enabled: state.status !== "running",
        run: () => layers.toggle("help"),
      },
      {
        id: "cycle-permission-mode",
        scope: "global",
        chords: b["cycle-permission-mode"],
        enabled: true,
        run: cyclePermissionMode,
      },
      {
        id: "details.toggle",
        scope: "global",
        chords: b["details.toggle"],
        enabled:
          transcriptViewport.mode === "detailed" ||
          state.events.length > 0 ||
          state.todoItems.length > 0,
        run: toggleTranscriptDetails,
      },
      {
        id: "transcript.page-up",
        scope: "global",
        chords: b["transcript.page-up"],
        enabled: transcriptLayout.rows.length > transcriptRows,
        run: () =>
          setTranscriptViewport((current) =>
            scrollTranscriptViewport(
              current,
              transcriptLayout,
              transcriptRows,
              -Math.max(1, transcriptRows - 1),
            ),
          ),
      },
      {
        id: "transcript.page-down",
        scope: "global",
        chords: b["transcript.page-down"],
        enabled: transcriptLayout.rows.length > transcriptRows,
        run: () =>
          setTranscriptViewport((current) =>
            scrollTranscriptViewport(
              current,
              transcriptLayout,
              transcriptRows,
              Math.max(1, transcriptRows - 1),
            ),
          ),
      },
      {
        id: "transcript.top",
        scope: "global",
        chords: b["transcript.top"],
        enabled: transcriptLayout.rows.length > 0,
        run: () =>
          setTranscriptViewport((current) =>
            moveTranscriptViewportToStart(current, transcriptLayout),
          ),
      },
      {
        id: "transcript.bottom",
        scope: "global",
        chords: b["transcript.bottom"],
        enabled: transcriptLayout.rows.length > 0,
        run: () =>
          setTranscriptViewport((current) =>
            moveTranscriptViewportToEnd(
              current,
              transcriptLayout,
              transcriptRows,
            ),
          ),
      },
      {
        id: "cancel.run",
        scope: "global",
        chords: b["cancel.run"].filter((chord) => !isPlainEscapeChord(chord)),
        enabled: state.status === "running",
        run: requestCancelRun,
      },
    ];
    return interactionRouter.route(input, key, draft, actions).handled;
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
    void modelPreferencesRef.current
      ?.recordRecent(nextModelName)
      .then(setModelPreferences);
    // A committed switch leaves one durable transcript row; no transient toast
    // on top of it (an unchanged pick just closes the dialog silently).
    if (changed) store.appendNotice(`model -> ${nextModelName} (next run)`);
    layers.pop("model");
    layers.pop("connect");
  }

  function toggleFavoriteModel(modelName: string): void {
    void modelPreferencesRef.current
      ?.toggleFavorite(modelName)
      .then(setModelPreferences);
  }

  async function refreshProviderCatalog(
    providerId?: string,
  ): Promise<ProviderCatalogSnapshot | null> {
    const refreshed = await controller.refreshProviderCatalog(providerId);
    if (refreshed) {
      store.appendNotice(
        `provider catalog -> ${refreshed.status} (generation ${refreshed.catalogState.generation})`,
      );
    }
    const catalog = await controller.listProviders(
      effModel,
      topLayer?.name === "connect" ? "all" : "available",
    );
    setProviderCatalog(catalog);
    return catalog;
  }

  async function submitProviderSecret(
    providerId: string,
    methodId: string,
    secret: string,
  ) {
    const connection = await controller.submitProviderSecret(
      providerId,
      methodId,
      secret,
    );
    if (connection) {
      store.appendNotice(
        `${providerId} connection -> ${connection.status} (${connection.id})`,
      );
    }
    return connection;
  }

  function updateProviderAuth(
    action: "login" | "logout" | "refresh",
    profileId: string,
  ): void {
    setLoadingProviders(true);
    void controller
      .updateProviderAuth(action, profileId)
      .then(async (profile) => {
        if (profile) {
          store.appendNotice(
            `${profile.providerId} auth -> ${profile.status} (generation ${profile.generation})`,
          );
        }
        const catalog = await controller.listProviders(effModel);
        setProviderCatalog(catalog);
        setLoadingProviders(false);
      });
  }

  // Only reserve the sidebar rail when the terminal is wide AND there's
  // something to show — an empty "modified files (none yet)" box pinned at the
  // bottom is just clutter.
  const hasSidebarContent = state.modifiedFiles.length > 0;
  const sidebarWidth = cols >= 100 && hasSidebarContent ? 32 : 0;

  // Bound the live answer by physical terminal height. The transcript remains
  // the only scrollable surface; very small screens degrade below the normal
  // 6–12 row range so the input and at least one transcript row stay visible.
  const streamingMax = resolveStreamingAnswerRows(screenRows);
  function closeTopLayer(): void {
    if (!topLayer) return;
    layers.pop(topLayer.name);
    if (topLayer.name === "session-rename")
      sessionActions.setRenameTarget(null);
  }

  // Props shared by layer renderers, assembled once so call sites do not drift.
  const layerProps = {
    registry,
    bindings: resolved.bindings,
    resolved: effectiveResolved,
    sessionList: sessionActions.sessionList,
    sessionRootLabel: resolved.sessionRootLabel,
    events: state.events,
    usage: state.usage,
    taskRecords: taskActions.taskRecords,
    taskOutputs: taskActions.taskOutputs,
    loadingTasks: taskActions.loadingTasks,
    workflows: workflowActions.workflows,
    loadingWorkflows: workflowActions.loadingWorkflows,
    selectedWorkflowId: workflowActions.selectedWorkflowId,
    ownedWorkflowRunIds: workflowActions.ownedWorkflowRunIds,
    ownedRunIds: workflowActions.ownedRunIds,
    labels: sessionActions.labels,
    renameTarget: sessionActions.renameTarget,
    effModel,
    modelCandidates: modelCandidates(resolved.providers),
    providerCatalog,
    loadingProviders,
    modelPreferences,
    projectTrust,
    loadingProjectTrust,
    sessionDiagnostics: sessionActions.sessionDiagnostics,
    loadingDiagnosticsFor: sessionActions.loadingDiagnosticsFor,
    capabilitySnapshot: capActions.capabilitySnapshot,
    loadingCapabilities: capActions.loadingCapabilities,
    skillsSnapshot: capActions.skillsSnapshot,
    loadingSkills: capActions.loadingSkills,
    notifications: toastSnapshot.history,
    onActivityTabChange: taskActions.handleActivityTabChange,
    onRefreshTasks: () => void taskActions.refreshTaskSnapshots(),
    onStopTask: taskActions.stopActivityTask,
    onJoinTask: taskActions.joinActivityTask,
    onPromoteTask: taskActions.promoteActivityTask,
    onRefreshWorkflows: () => void workflowActions.refreshWorkflows(),
    onSelectWorkflow: workflowActions.selectWorkflow,
    onCommitModel: commitModelSelection,
    onToggleFavoriteModel: toggleFavoriteModel,
    onProviderAuth: updateProviderAuth,
    onLoadProviderAuthMethods: (providerId: string) =>
      controller.listProviderAuthMethods(providerId),
    onSubmitProviderSecret: submitProviderSecret,
    onBeginProviderOAuth: (providerId: string, methodId: string) =>
      controller.beginProviderOAuth(providerId, methodId),
    onInspectProviderOAuth: (attemptId: string) =>
      controller.inspectProviderOAuth(attemptId),
    onCompleteProviderOAuth: (attemptId: string, code: string) =>
      controller.completeProviderOAuth(attemptId, code),
    onCancelProviderOAuth: (attemptId: string) =>
      controller.cancelProviderOAuth(attemptId),
    onRefreshProviderCatalog: refreshProviderCatalog,
    onGrantProjectTrust: grantProjectTrust,
    onRevokeProjectTrust: revokeProjectTrust,
    onFork: sessionActions.forkSession,
    onCloseTop: closeTopLayer,
    onInspectSession: (id: string) => void sessionActions.inspectSession(id),
    onPickSession: sessionActions.pickSession,
    onRequestRename: sessionActions.requestRename,
    onCommitRename: sessionActions.commitRename,
    onApprovalDecision: (choice) => void controller.resolveApproval(choice),
    onCreateCapability: capActions.handleCreateCapability,
  } satisfies Omit<React.ComponentProps<typeof LayerRenderer>, "entry">;

  return (
    <ThemeProvider theme={theme}>
      <Box flexDirection="column" height={screenRows} overflow="hidden">
        {/* A blocking layer owns both input and the visible operation surface.
          Transcript state remains mounted in App and resumes at its semantic
          anchor when the layer closes. */}
        {topLayer ? (
          <LayerRenderer entry={topLayer} {...layerProps} />
        ) : (
          <>
            <TranscriptViewport
              layout={transcriptLayout}
              state={transcriptViewport}
              rows={transcriptRows}
            />
            <LiveFrame
              state={state}
              modelLabel={modelLabel}
              permissionMode={effTuiPermissionMode}
              focused={focused}
              runningTaskCount={taskActions.taskActivity.running}
              unreadTasks={taskActions.unreadTasks}
              waitingWorkflowCount={workflowActions.waitingWorkflowCount}
              streamingMax={streamingMax}
              sidebarWidth={sidebarWidth}
              columns={cols}
              toast={toastSnapshot.current}
              toastQueueDepth={toastSnapshot.queueDepth}
              errors={resolved.errors}
              queued={queued}
              showQueued
              onHeightChange={setLiveFrameRows}
            />
            {transcriptViewport.mode === "detailed" ? (
              <TranscriptBrowseFooter
                onClose={toggleTranscriptDetails}
                onLineUp={() => scrollTranscriptBy(-1)}
                onLineDown={() => scrollTranscriptBy(1)}
                onTop={() =>
                  setTranscriptViewport((current) =>
                    moveTranscriptViewportToStart(current, transcriptLayout),
                  )
                }
                onBottom={() =>
                  setTranscriptViewport((current) =>
                    moveTranscriptViewportToEnd(
                      current,
                      transcriptLayout,
                      transcriptRows,
                    ),
                  )
                }
                onGlobalInput={(input, key) => routeGlobalInput(input, key, "")}
              />
            ) : isRawModeSupported ? (
              <InputBox
                // Stay editable while a run is in flight: Enter steers and
                // /followup schedules the next run.
                disabled={false}
                placeholder={
                  state.status === "running" ||
                  state.status === "awaiting-approval"
                    ? "running — Enter steers · /followup queues next · esc cancels"
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
                  if (
                    state.status === "running" &&
                    resolved.bindings["cancel.run"].some(isPlainEscapeChord)
                  ) {
                    requestCancelRun();
                  }
                }}
                onQuit={requestQuit}
                onQuitClear={noteInputClearedByQuit}
                stashRef={stashRef}
                onStashChange={(next) => {
                  stashRef.current = next;
                }}
                initialDraft={inputDraftRef.current}
                onDraftChange={(next) => {
                  inputDraftRef.current = next;
                }}
                onGlobalInput={routeGlobalInput}
                handleRef={inputHandleRef}
                onHeightChange={setInputFrameRows}
              />
            ) : (
              <Box paddingX={1}>
                <Text dimColor>
                  (input disabled — stdin is not a TTY; run from a real
                  terminal)
                </Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </ThemeProvider>
  );
}
