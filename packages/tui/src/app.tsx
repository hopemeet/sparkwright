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
import { ApprovalPrompt } from "./components/approval-prompt.js";
import { InputBox } from "./components/input-box.js";
import { StreamingMessage } from "./components/streaming-message.js";
import { SessionListDialog } from "./components/session-list-dialog.js";
import { SessionRenameDialog } from "./components/session-rename-dialog.js";
import { CommandPalette } from "./components/command-palette.js";
import { EventDetailPanel } from "./components/event-detail.js";
import { QuickSwitchDialog } from "./components/quick-switch-dialog.js";
import { ToastView } from "./components/toast.js";
import { loadSessionLabels, type SessionLabels } from "./lib/session-labels.js";
import { ThemeProvider, useTheme } from "./lib/theme-context.js";
import { resolveTheme, THEMES, type Theme } from "./lib/theme.js";
import { StashDialog } from "./components/stash-dialog.js";
import { ModelDialog } from "./components/model-dialog.js";
import { TimelineDialog } from "./components/timeline-dialog.js";
import { CreateCapabilityDialog } from "./components/create-capability-dialog.js";
import { loadStash, type StashFile } from "./lib/stash.js";
import type { InputBoxHandle } from "./components/input-box.js";
import { Sidebar, UsageSummaryLine } from "./components/sidebar.js";
import { TodoBand } from "./components/todo-band.js";
import { StatusBar } from "./components/status-bar.js";
import { Spinner } from "./components/spinner.js";
import { QueuedMessages } from "./components/queued-messages.js";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import { copyToClipboard } from "./lib/clipboard.js";
import { lastAssistantMessage } from "./lib/transcript.js";
import { AttentionManager } from "./lib/attention.js";
import { CommandRegistry } from "./lib/commands.js";
import {
  createCapability,
  type CreateCapabilityDraft,
  type CreateCapabilityKind,
} from "./lib/create-capability.js";
import type { ProjectCommandDescriptor } from "@sparkwright/project-commands";
import {
  loadProjectCommands,
  resolveProjectCommandIntent,
  toTuiProjectCommands,
} from "./lib/project-commands.js";
import {
  chordMatches,
  formatBinding,
  DEFAULTS as DEFAULT_BINDINGS,
  type Bindings,
} from "./lib/keybindings.js";
import type { SessionDiagnostics, SessionSummary } from "./lib/sessions.js";
import type { PermissionMode } from "./state/run-controller.js";
import {
  loadTuiConfig,
  watchTuiConfig,
  type LoadedTuiConfig,
  type SourceMap,
  type TuiConfigFile,
  type ValidationError,
} from "./lib/config.js";

export interface CliOverrides {
  workspaceRoot?: string;
  sessionRootDir?: string;
  permissionMode?: PermissionMode;
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
  permissionMode: PermissionMode;
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
}

type CapabilityView = "all" | "tools" | "skills" | "agents" | "mcp" | "cron";

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

  const modelName = cli.modelName ?? loaded.config.model;
  const modelNameSource = cli.modelName
    ? ("request" as const)
    : loaded.config.model
      ? ("config" as const)
      : undefined;
  if (cli.modelName) sources.model = "cli:--model";

  const permissionMode: PermissionMode =
    cli.permissionMode ?? loaded.config.permissionMode ?? "default";
  if (cli.permissionMode) sources.permissionMode = "cli:--permission-mode";
  else if (!loaded.config.permissionMode) sources.permissionMode = "default";

  if (!loaded.config.theme) sources.theme = "default";

  return {
    workspaceRoot,
    sessionRootDir,
    permissionMode,
    modelName,
    modelNameSource,
    providers: loaded.config.providers,
    sources,
    attempted: loaded.attempted,
    errors: loaded.errors,
    bindings: loaded.config.resolvedBindings ?? DEFAULT_BINDINGS,
    theme: resolveTheme(loaded.config.theme),
    mouse: loaded.config.mouse ?? true,
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
        permissionMode: resolved.permissionMode,
        modelName: resolved.modelName,
        modelNameSource: resolved.modelNameSource,
        initialSessionId: props.cliOverrides.sessionId,
        store,
      }),
    [resolved.workspaceRoot, resolved.sessionRootDir, store],
  );

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
  const [labels, setLabels] = useState<Record<string, string>>({});
  const labelsRef = useRef<SessionLabels | null>(null);
  // Double-Ctrl+C-to-exit: the first press (when idle) arms a brief window;
  // exit only happens if a second Ctrl+C lands before it expires. Stored as a
  // timer handle so we can disarm it. Avoids quitting the whole TUI on a single
  // accidental Ctrl+C.
  const quitArmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  // Runtime theme override from /theme; falls back to the configured theme.
  const [themeOverride, setThemeOverride] = useState<Theme | null>(null);
  const theme = themeOverride ?? resolved.theme;
  // Todo band: collapsed by default (active items only); ctrl+o expands to show
  // completed items too.
  const [todoExpanded, setTodoExpanded] = useState(false);
  // Prompt stash bridge — the InputBox reads/writes through this ref.
  const stashRef = useRef<StashFile>({ current: null, list: [] });
  const [stashList, setStashList] = useState<StashFile["list"]>([]);
  const inputHandleRef = useRef<InputBoxHandle | null>(null);
  // Runtime model-ref override from /model; falls back to config.
  const [modelOverride, setModelOverride] = useState<{
    modelName?: string;
  } | null>(null);
  const effModel = modelOverride ? modelOverride.modelName : resolved.modelName;

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
      setStashList(s.list);
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
        attention.notify("run done");
        toasts.push({
          variant: "success",
          title: "run done",
          message: state.stopReason ?? "completed",
        });
      }
    }
    lastStatus.current = state.status;
  }, [state.status, state.lastError, state.stopReason, attention, toasts]);

  async function reloadConfig(verbose: boolean): Promise<void> {
    const loaded = await loadTuiConfig(props.initialCwd);
    const r = resolveConfig(loaded, props.cliOverrides, props.initialCwd);
    if (!modelOverride && r.modelName !== resolved.modelName) {
      controller.updateModel(r.modelName, r.modelNameSource);
    }
    if (r.permissionMode !== resolved.permissionMode) {
      controller.updatePermissionMode(r.permissionMode);
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

  async function openQuickSwitch(): Promise<void> {
    // Re-fetch every time — sessions list isn't large and may have grown
    // since the user last looked.
    const sessions = await controller.listSessions();
    setSessionList(sessions);
    layers.push("quick-switch");
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
          ? `${result.message} · ${result.path}`
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

  // Build the command registry once per controller. App-level handlers are
  // closed over here; both the palette and `/foo` input share this list.
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
      name: "palette",
      title: "Open command palette",
      description: "Search every available command.",
      category: "view",
      hint: formatBinding(resolved.bindings["palette.open"]) || undefined,
      aliases: ["p", "cmd"],
      run: () => layers.toggle("palette"),
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
      name: "sessions",
      title: "Browse past sessions",
      description: "List, inspect diagnostics, resume.",
      category: "session",
      run: () => void openSessionList(),
    });
    reg.register({
      name: "quick",
      title: "Quick switch session",
      description: "Jump to one of the 9 most recent sessions by number.",
      category: "session",
      hint: formatBinding(resolved.bindings["quick.switch"]) || undefined,
      run: () => void openQuickSwitch(),
    });
    reg.register({
      name: "events",
      title: "Inspect event detail",
      description: "Browse recent events, expand a row to see full payload.",
      category: "view",
      hint: formatBinding(resolved.bindings["events.open"]) || undefined,
      run: () => layers.toggle("events"),
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
      run: () => openCreateCapability(),
      runRaw: (rest) => openCreateCapability(rest),
    });
    reg.register({
      name: "tools",
      title: "Browse tools",
      description: "Show prepared tools, risk, and origin.",
      category: "view",
      run: () => void openCapabilities("tools"),
    });
    reg.register({
      name: "skills",
      title: "Browse Skills",
      description: "Show Skills SparkWright can discover or load.",
      category: "view",
      run: () => void openCapabilities("skills"),
    });
    reg.register({
      name: "agents",
      title: "Browse agents",
      description: "Show configured agent profiles.",
      category: "view",
      run: () => void openCapabilities("agents"),
    });
    reg.register({
      name: "mcp",
      title: "Browse MCP servers",
      description: "Show configured MCP servers and their exposed tools.",
      category: "view",
      run: () => void openCapabilities("mcp"),
    });
    reg.register({
      name: "cron",
      title: "Browse cron support",
      description: "Show cron-related tools and capability status.",
      category: "view",
      run: () => void openCapabilities("cron"),
    });
    reg.register({
      name: "reload",
      title: "Reload config files",
      description: "Re-read sparkwright.tui.json now.",
      category: "config",
      run: () => void reloadConfig(true),
    });
    reg.register({
      name: "theme",
      title: "Cycle theme",
      description: "Switch between dark / light / mono (session-only).",
      category: "config",
      run: () => {
        const ids = Object.keys(THEMES);
        const currentId = (themeOverride ?? resolved.theme).id;
        const nextId = ids[(ids.indexOf(currentId) + 1) % ids.length];
        setThemeOverride(THEMES[nextId]);
        toasts.push({
          variant: "info",
          title: "theme",
          message: `${nextId} (set "theme" in config to persist)`,
        });
      },
    });
    reg.register({
      name: "stash",
      title: "Browse stashed drafts",
      description: "Restore an unsubmitted draft snapshot into the input.",
      category: "view",
      run: () => layers.toggle("stash"),
    });
    reg.register({
      name: "model",
      title: "Switch model",
      description: "Change the model reference for the next run.",
      category: "config",
      run: () => layers.toggle("model"),
    });
    reg.register({
      name: "fork",
      title: "Fork session at a turn",
      description: "Branch a new session from a chosen point in history.",
      category: "session",
      run: () => layers.toggle("timeline"),
    });
    reg.register({
      name: "trace",
      title: "Dump trace to disk",
      description: "Write the in-memory event log to .sparkwright/tui-traces.",
      category: "system",
      run: () => {
        controller
          .dumpTrace()
          .then((path) =>
            toasts.push({
              variant: "success",
              title: "trace written",
              message: path,
            }),
          )
          .catch((err) =>
            toasts.push({
              variant: "error",
              title: "trace failed",
              message: String(err),
            }),
          );
      },
    });
    reg.register({
      name: "copy",
      title: "Copy last answer",
      description:
        "Copy the most recent assistant message to the system clipboard (OSC 52).",
      category: "view",
      aliases: ["yank"],
      run: () => {
        // Read the live snapshot, not the closed-over `state` — the registry
        // is only rebuilt on status changes, so `state.events` would be stale
        // mid-run.
        const message = lastAssistantMessage(store.getSnapshot().events);
        if (!message) {
          toasts.push({ variant: "warning", message: "no answer to copy yet" });
          return;
        }
        const ok = copyToClipboard(message);
        toasts.push(
          ok
            ? {
                variant: "success",
                title: "copied",
                message: `${message.length} chars to clipboard`,
              }
            : {
                variant: "warning",
                message: "clipboard unavailable (not a TTY)",
              },
        );
      },
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
          .then((path) =>
            toasts.push({
              variant: "success",
              title: "transcript exported",
              message: path,
            }),
          )
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
      name: "cancel",
      title: "Cancel running goal",
      description: "Sends a cancel to the host.",
      category: "system",
      hint: formatBinding(resolved.bindings["cancel.run"]) || undefined,
      available: () => state.status === "running",
      run: () => {
        if (controller.cancel())
          toasts.push({ variant: "info", message: "cancelling…" });
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
    // Re-build when state.status changes so `available()` updates the
    // palette grey-out, and when bindings change so hint strings refresh.
  }, [
    layers,
    store,
    controller,
    toasts,
    state.status,
    resolved.bindings,
    resolved.theme,
    themeOverride,
    projectCommands,
  ]);

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
    void controller.start(value);
  }

  // Drain the prompt queue: when a run finishes and the controller is free,
  // start the next queued goal. Gated on `controller.isRunning()` so we never
  // double-start, and only on a settled status so an in-flight run is left
  // alone. Errors pause draining (the user likely wants to look) — they can
  // resubmit to resume.
  useEffect(() => {
    if (state.status !== "done" && state.status !== "idle") return;
    if (controller.isRunning() || queued.length === 0) return;
    const next = queue.dequeue();
    if (next) void controller.start(next);
  }, [state.status, queued.length, controller, queue]);

  // Layer-aware hotkeys: when a layer owns input, the App-level hotkeys
  // step back so they don't double-handle keys. Each binding is resolved
  // through `resolved.bindings`, so user overrides in sparkwright.tui.json
  // take effect on /reload.
  function Hotkeys(): null {
    const b = resolved.bindings;
    useInput((input, key) => {
      const top = layers.top();
      if (b["quit.app"].some((c) => chordMatches(c, key, input))) {
        // Ctrl+C is a single key that means three different things depending on
        // state, so a lone press should never drop the user out of the TUI:
        //   1. A run is in flight → cancel it (this is what the user reaches for
        //      when esc-to-cancel is forgotten), and don't exit.
        //   2. Already armed → second press within the window actually exits.
        //   3. Otherwise → arm the quit window and tell the user to press again.
        if (state.status === "running") {
          if (controller.cancel())
            toasts.push({ variant: "info", message: "cancelling…" });
          return;
        }
        if (quitArmRef.current) {
          clearTimeout(quitArmRef.current);
          quitArmRef.current = null;
          exit();
          return;
        }
        quitArmRef.current = setTimeout(() => {
          quitArmRef.current = null;
        }, 2000);
        toasts.push({
          variant: "info",
          message: "press ctrl+c again to exit",
        });
        return;
      }
      if (
        top?.name !== "approval" &&
        b["palette.open"].some((c) => chordMatches(c, key, input))
      ) {
        layers.toggle("palette");
        return;
      }
      if (
        top?.name !== "approval" &&
        b["events.open"].some((c) => chordMatches(c, key, input))
      ) {
        layers.toggle("events");
        return;
      }
      if (
        top?.name !== "approval" &&
        b["quick.switch"].some((c) => chordMatches(c, key, input))
      ) {
        void openQuickSwitch();
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

  const cols = stdout?.columns ?? 100;
  // Only reserve the sidebar rail when the terminal is wide AND there's
  // something to show — an empty "modified files (none yet)" box pinned at the
  // bottom is just clutter.
  const hasSidebarContent = state.modifiedFiles.length > 0;
  const sidebarWidth = cols >= 100 && hasSidebarContent ? 32 : 0;

  // Cap the live stream panel so a long in-flight message can't push the input
  // off-screen. Committed lines are in scrollback, so nothing else is clamped.
  const streamingMax = Math.max(3, termRows - 16);

  const closeTopLayer = (): void => {
    if (!topLayer) return;
    layers.pop(topLayer.name);
    if (topLayer.name === "events") {
      toasts.push({ variant: "info", message: "closed events" });
    }
    if (topLayer.name === "session-rename") setRenameTarget(null);
  };

  if (topLayer?.name === "events") {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <LayerRenderer
            entry={topLayer}
            registry={registry}
            controller={controller}
            resolved={resolved}
            sessionList={sessionList}
            currentSessionId={state.sessionId}
            events={state.events}
            labels={labels}
            renameTarget={renameTarget}
            stashList={stashList}
            effModel={effModel}
            sessionDiagnostics={sessionDiagnostics}
            loadingDiagnosticsFor={loadingDiagnosticsFor}
            capabilitySnapshot={capabilitySnapshot}
            loadingCapabilities={loadingCapabilities}
            onPickStash={(text) => {
              inputHandleRef.current?.setValue(text);
              layers.pop("stash");
            }}
            onCommitModel={(modelName) => {
              const nextModelName = modelName.trim() || "deterministic";
              setModelOverride({ modelName: nextModelName });
              controller.updateModel(nextModelName, "request");
              layers.pop("model");
              toasts.push({
                variant: "success",
                title: "model",
                message: `${nextModelName} (next run)`,
              });
            }}
            onFork={(seq) => {
              const src = state.sessionId;
              layers.pop("timeline");
              if (!src) return;
              void controller.forkSession(src, seq).then((res) => {
                if (!res) return;
                void controller.switchSession(res.forkedSessionId);
                toasts.push({
                  variant: "success",
                  title: "forked",
                  message: `${res.forkedSessionId} (${res.copiedEventCount} events copied)`,
                });
              });
            }}
            onCloseTop={closeTopLayer}
            onInspectSession={(id) => void inspectSession(id)}
            onPickSession={(id) => {
              void controller.switchSession(id);
              layers.pop("sessions");
              layers.pop("quick-switch");
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
          input (run completion/failure already surfaces as a toast). */}
        {state.status === "running" || state.status === "awaiting-approval" ? (
          <StatusBar
            state={state}
            modelLabel={modelLabel}
            permissionMode={resolved.permissionMode}
            focused={focused}
          />
        ) : null}

        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1}>
            {state.streamingText || state.reasoningText ? (
              <StreamingMessage
                text={state.streamingText}
                reasoning={state.reasoningText}
                maxLines={streamingMax}
              />
            ) : state.status === "running" && state.activeTool ? (
              <Box paddingX={1} marginTop={1}>
                <Spinner color={theme.accent} />
                <Text color={theme.muted}> running </Text>
                <Text color={theme.accent}>{state.activeTool}</Text>
                <Text color={theme.muted}>…</Text>
              </Box>
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
            controller={controller}
            resolved={resolved}
            sessionList={sessionList}
            currentSessionId={state.sessionId}
            events={state.events}
            labels={labels}
            renameTarget={renameTarget}
            stashList={stashList}
            effModel={effModel}
            sessionDiagnostics={sessionDiagnostics}
            loadingDiagnosticsFor={loadingDiagnosticsFor}
            capabilitySnapshot={capabilitySnapshot}
            loadingCapabilities={loadingCapabilities}
            onPickStash={(text) => {
              inputHandleRef.current?.setValue(text);
              layers.pop("stash");
            }}
            onCommitModel={(modelName) => {
              const nextModelName = modelName.trim() || "deterministic";
              setModelOverride({ modelName: nextModelName });
              controller.updateModel(nextModelName, "request");
              layers.pop("model");
              toasts.push({
                variant: "success",
                title: "model",
                message: `${nextModelName} (next run)`,
              });
            }}
            onFork={(seq) => {
              const src = state.sessionId;
              layers.pop("timeline");
              if (!src) return;
              void controller.forkSession(src, seq).then((res) => {
                if (!res) return;
                // Switch to the fork AND load its (copied) history so the
                // branched conversation is visible, not a blank screen.
                void controller.switchSession(res.forkedSessionId);
                toasts.push({
                  variant: "success",
                  title: "forked",
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
              layers.pop("quick-switch");
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
            stashRef={stashRef}
            onStashChange={(next) => {
              stashRef.current = next;
              setStashList(next.list);
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

        <Box paddingX={1}>
          <Text dimColor>{inputFooterText(resolved.bindings)}</Text>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

function inputFooterText(bindings: Bindings): string {
  const items = ["enter run", "\\↵ newline", "/ commands", "@ files"];
  for (const [name, label] of [
    ["history.search", "search"],
    ["palette.open", "palette"],
    ["events.open", "events"],
    ["quick.switch", "switch"],
    ["cancel.run", "cancel"],
    ["quit.app", "quit"],
  ] as const) {
    const binding = formatBinding(bindings[name]);
    if (binding) items.push(`${binding} ${label}`);
  }
  return items.join(" · ");
}

/**
 * Renders the topmost layer. Kept inline (not a separate file) because the
 * mapping is tiny and the layer payloads are tightly coupled to App state.
 */
function LayerRenderer(props: {
  entry: { name: string };
  registry: CommandRegistry;
  controller: RunController;
  resolved: Resolved;
  sessionList: SessionSummary[];
  currentSessionId: string | null;
  events: import("./lib/event-type.js").RunEvent[];
  labels: Record<string, string>;
  renameTarget: string | null;
  stashList: StashFile["list"];
  effModel?: string;
  sessionDiagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  capabilitySnapshot: CapabilitySnapshot | null;
  loadingCapabilities: boolean;
  onCloseTop: () => void;
  onInspectSession: (id: string) => void;
  onPickSession: (id: string) => void;
  onRequestRename: (id: string) => void;
  onCommitRename: (id: string, label: string) => void;
  onPickStash: (text: string) => void;
  onCommitModel: (model: string) => void;
  onFork: (forkAtSequence: number | undefined, label: string) => void;
  onApprovalDecision: (d: "approved" | "denied") => void;
  onCreateCapability: (draft: CreateCapabilityDraft) => void;
}): React.ReactElement | null {
  const e = props.entry as { name: string; payload?: unknown };
  switch (e.name) {
    case "approval":
      return (
        <ApprovalPrompt
          pending={e.payload as Parameters<typeof ApprovalPrompt>[0]["pending"]}
          onDecision={props.onApprovalDecision}
        />
      );
    case "palette":
      return (
        <CommandPalette
          registry={props.registry}
          onCancel={props.onCloseTop}
          onPick={(cmd) => {
            props.onCloseTop();
            void cmd.run();
          }}
        />
      );
    case "sessions":
      return (
        <SessionListDialog
          sessions={props.sessionList}
          labels={props.labels}
          diagnostics={props.sessionDiagnostics}
          loadingDiagnosticsFor={props.loadingDiagnosticsFor}
          onCancel={props.onCloseTop}
          onInspect={props.onInspectSession}
          onPick={props.onPickSession}
          onRename={props.onRequestRename}
        />
      );
    case "quick-switch":
      return (
        <QuickSwitchDialog
          sessions={props.sessionList}
          currentSessionId={props.currentSessionId}
          labels={props.labels}
          onCancel={props.onCloseTop}
          onPick={props.onPickSession}
        />
      );
    case "session-rename":
      if (!props.renameTarget) return null;
      return (
        <SessionRenameDialog
          sessionId={props.renameTarget}
          initialLabel={props.labels[props.renameTarget] ?? ""}
          onCancel={props.onCloseTop}
          onCommit={(label) => props.onCommitRename(props.renameTarget!, label)}
        />
      );
    case "events":
      return (
        <EventDetailPanel events={props.events} onClose={props.onCloseTop} />
      );
    case "stash":
      return (
        <StashDialog
          entries={[...props.stashList].reverse()}
          onCancel={props.onCloseTop}
          onPick={props.onPickStash}
        />
      );
    case "model":
      return (
        <ModelDialog
          model={props.effModel ?? ""}
          candidates={modelCandidates(props.resolved.providers)}
          onCancel={props.onCloseTop}
          onCommit={props.onCommitModel}
        />
      );
    case "timeline":
      return (
        <TimelineDialog
          events={props.events}
          onCancel={props.onCloseTop}
          onFork={props.onFork}
        />
      );
    case "help":
      return <HelpPanel registry={props.registry} onClose={props.onCloseTop} />;
    case "config":
      return (
        <ConfigPanel resolved={props.resolved} onClose={props.onCloseTop} />
      );
    case "capabilities":
      return (
        <CapabilitiesPanel
          snapshot={props.capabilitySnapshot}
          loading={props.loadingCapabilities}
          view={capabilityViewFromPayload(e.payload)}
          onClose={props.onCloseTop}
        />
      );
    case "create":
      return (
        <CreateCapabilityDialog
          initialKind={createKindFromPayload(e.payload)}
          onCancel={props.onCloseTop}
          onCommit={props.onCreateCapability}
        />
      );
    default:
      return null;
  }
}

function createKindFromRest(rest: string): CreateCapabilityKind | undefined {
  const value = rest.trim().toLowerCase().split(/\s+/u)[0];
  return createKindFromString(value);
}

function createKindFromPayload(
  payload: unknown,
): CreateCapabilityKind | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    "kind" in payload &&
    typeof payload.kind === "string"
  ) {
    return createKindFromString(payload.kind);
  }
  return undefined;
}

function createKindFromString(value: string): CreateCapabilityKind | undefined {
  switch (value) {
    case "skill":
    case "agent":
    case "cron":
    case "command":
    case "mcp":
      return value;
    default:
      return undefined;
  }
}

function HelpPanel(props: {
  registry: CommandRegistry;
  onClose: () => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });
  const cmds = props.registry.list();
  const grouped = new Map<string, typeof cmds>();
  for (const c of cmds) {
    const g = grouped.get(c.category) ?? [];
    g.push(c);
    grouped.set(c.category, g);
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Text color="magenta" bold>
        keyboard / commands
      </Text>
      {[...grouped.entries()].map(([cat, list]) => (
        <Box key={cat} flexDirection="column" marginTop={1}>
          <Text bold>{cat}</Text>
          {list.map((c) => (
            <Box key={c.name}>
              <Text color="cyan">/{c.name}</Text>
              <Text> </Text>
              <Text>{c.title}</Text>
              {c.hint ? <Text dimColor> [{c.hint}]</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>esc / enter to close</Text>
      </Box>
    </Box>
  );
}

function ConfigPanel(props: {
  resolved: Resolved;
  onClose: () => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });
  const r = props.resolved;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text color="cyan" bold>
        resolved config (esc to close)
      </Text>
      <Text>
        <Text dimColor>workspace: </Text>
        {r.workspaceRoot}
        <Text dimColor> ({r.sources.workspace ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>model: </Text>
        {r.modelName ?? "—"}
        <Text dimColor> ({r.sources.model ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>permissionMode: </Text>
        {r.permissionMode}
        <Text dimColor> ({r.sources.permissionMode ?? "?"})</Text>
      </Text>
      {r.providers && Object.keys(r.providers).length > 0 ? (
        <Text>
          <Text dimColor>providers: </Text>
          {Object.keys(r.providers).join(", ")}
        </Text>
      ) : null}
      <Text> </Text>
      <Text color="cyan">files attempted</Text>
      {r.attempted.map((a) => (
        <Text key={a.path} color={a.loaded ? "green" : undefined}>
          {a.loaded ? "✓ " : "  "}
          <Text dimColor={!a.loaded}>{a.path}</Text>
        </Text>
      ))}
    </Box>
  );
}

function capabilityViewFromPayload(payload: unknown): CapabilityView {
  if (
    payload &&
    typeof payload === "object" &&
    "view" in payload &&
    typeof payload.view === "string" &&
    ["all", "tools", "skills", "agents", "mcp", "cron"].includes(payload.view)
  ) {
    return payload.view as CapabilityView;
  }
  return "all";
}

function CapabilitiesPanel(props: {
  snapshot: CapabilitySnapshot | null;
  loading: boolean;
  view: CapabilityView;
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });
  const s = props.snapshot;
  const tools = s?.tools ?? [];
  const indexed = s?.skills.indexed ?? [];
  const loaded = s?.skills.loaded ?? [];
  const mcp = s?.mcp.statuses ?? [];
  const agents = s?.agents.profiles ?? [];
  const delegateTools = s?.agents.delegateTools ?? [];
  const cronTools = tools.filter((tool) =>
    tool.name.toLowerCase().includes("cron"),
  );
  const title = capabilityPanelTitle(props.view);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Text color={theme.accent} bold>
        {title}
        <Text color={theme.muted}>
          {" "}
          available to this run · esc/enter close
        </Text>
      </Text>
      {props.loading ? <Text color={theme.muted}>loading…</Text> : null}
      {!props.loading && !s ? (
        <Text color={theme.muted}>no snapshot available</Text>
      ) : null}
      {s ? (
        <>
          <CapabilityOverview
            tools={tools}
            indexedSkills={indexed}
            loadedSkills={loaded}
            agents={agents}
            delegateTools={delegateTools}
            mcp={mcp}
            cronTools={cronTools}
          />

          {props.view === "all" || props.view === "tools" ? (
            <ToolsCapabilitySection tools={tools} />
          ) : null}

          {props.view === "all" || props.view === "skills" ? (
            <SkillsCapabilitySection indexed={indexed} loaded={loaded} />
          ) : null}

          {props.view === "all" || props.view === "agents" ? (
            <AgentsCapabilitySection
              agents={agents}
              delegateTools={delegateTools}
            />
          ) : null}

          {props.view === "all" || props.view === "mcp" ? (
            <McpCapabilitySection mcp={mcp} />
          ) : null}

          {props.view === "cron" ? (
            <CronCapabilitySection tools={cronTools} />
          ) : null}
        </>
      ) : null}
    </Box>
  );
}

function capabilityPanelTitle(view: CapabilityView): string {
  switch (view) {
    case "tools":
      return "tools";
    case "skills":
      return "skills";
    case "agents":
      return "agents";
    case "mcp":
      return "mcp";
    case "cron":
      return "cron";
    case "all":
    default:
      return "capabilities";
  }
}

function CapabilityOverview(props: {
  tools: CapabilitySnapshot["tools"];
  indexedSkills: CapabilitySnapshot["skills"]["indexed"];
  loadedSkills: CapabilitySnapshot["skills"]["loaded"];
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
  mcp: CapabilitySnapshot["mcp"]["statuses"];
  cronTools: CapabilitySnapshot["tools"];
}): React.ReactElement {
  const theme = useTheme();
  const unloadedSkills = Math.max(
    0,
    props.indexedSkills.length - props.loadedSkills.length,
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.success}>Available now: </Text>
        {props.tools.length} tools, {props.loadedSkills.length} loaded Skills,{" "}
        {props.agents.length} agents, {props.delegateTools.length} delegates,{" "}
        {props.mcp.length} MCP servers
      </Text>
      <Text color={theme.muted}>
        Indexed Skills are discoverable examples; loaded Skills were selected
        for the current run context.
      </Text>
      {unloadedSkills > 0 ? (
        <Text color={theme.muted}>
          {unloadedSkills} more Skill{unloadedSkills === 1 ? "" : "s"} can be
          loaded when relevant.
        </Text>
      ) : null}
      {props.cronTools.length > 0 ? (
        <Text color={theme.muted}>
          Cron support is present through {props.cronTools.length} prepared tool
          {props.cronTools.length === 1 ? "" : "s"}.
        </Text>
      ) : null}
    </Box>
  );
}

function ToolsCapabilitySection(props: {
  tools: CapabilitySnapshot["tools"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`tools (${props.tools.length})`}
      empty="no tools reported"
      count={props.tools.length}
    >
      {props.tools.slice(0, 24).map((tool) => (
        <Text key={tool.name}>
          <Text color={theme.success}>• </Text>
          {tool.name}
          {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
          {tool.origin ? (
            <Text color={theme.muted}> · {tool.origin}</Text>
          ) : null}
        </Text>
      ))}
      {props.tools.length > 24 ? (
        <Text color={theme.muted}>… {props.tools.length - 24} more</Text>
      ) : null}
    </CapabilitySection>
  );
}

function SkillsCapabilitySection(props: {
  indexed: CapabilitySnapshot["skills"]["indexed"];
  loaded: CapabilitySnapshot["skills"]["loaded"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`skills (${props.loaded.length} loaded / ${props.indexed.length} indexed)`}
      empty="no skills reported"
      count={props.loaded.length + props.indexed.length}
    >
      {props.loaded.map((skill) => (
        <Text key={`loaded:${skill.name}`}>
          <Text color={theme.success}>loaded </Text>
          {skill.name}
          {skill.selectionReason ? (
            <Text color={theme.muted}> · {skill.selectionReason}</Text>
          ) : null}
        </Text>
      ))}
      {props.loaded.length === 0
        ? props.indexed.slice(0, 16).map((skill) => (
            <Text key={`indexed:${skill.name}`}>
              <Text color={theme.muted}>indexed </Text>
              {skill.name}
              {skill.sourcePath ? (
                <Text color={theme.muted}> · {skill.sourcePath}</Text>
              ) : null}
            </Text>
          ))
        : null}
      {props.loaded.length === 0 && props.indexed.length > 16 ? (
        <Text color={theme.muted}>… {props.indexed.length - 16} more</Text>
      ) : null}
    </CapabilitySection>
  );
}

function AgentsCapabilitySection(props: {
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
}): React.ReactElement {
  const theme = useTheme();
  const count = props.agents.length + props.delegateTools.length;
  return (
    <CapabilitySection
      title={`agents (${props.agents.length} / ${props.delegateTools.length} delegates)`}
      empty="no agents reported"
      count={count}
    >
      {props.agents.map((agent) => (
        <Text key={agent.id}>
          <Text color={theme.success}>• </Text>
          {agent.name ?? agent.id}
          {agent.mode ? <Text color={theme.muted}> · {agent.mode}</Text> : null}
        </Text>
      ))}
      {props.delegateTools.map((tool) => (
        <Text key={tool.toolName}>
          <Text color={theme.success}>delegate </Text>
          {tool.toolName}
          <Text color={theme.muted}>
            {" "}
            → {tool.profileId} · {tool.protocol} ·{" "}
            {tool.requiresApproval ? "approval" : "no approval"} · workspace{" "}
            {tool.workspaceAccess}
          </Text>
        </Text>
      ))}
    </CapabilitySection>
  );
}

function McpCapabilitySection(props: {
  mcp: CapabilitySnapshot["mcp"]["statuses"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`mcp (${props.mcp.length})`}
      empty="no MCP servers reported"
      count={props.mcp.length}
    >
      {props.mcp.map((server) => (
        <Box key={server.serverName} flexDirection="column">
          <Text>
            <Text color={theme.success}>• </Text>
            {server.serverName}
            <Text color={theme.muted}>
              {" "}
              · {server.status} · {server.toolNames.length} tools
            </Text>
            {server.errorCode ? (
              <Text color={theme.error}>
                {" "}
                · {server.errorCode}
                {server.errorPhase ? ` (${server.errorPhase})` : ""}
              </Text>
            ) : null}
          </Text>
          {server.toolNames.length > 0 ? (
            <Text color={theme.muted}> {server.toolNames.join(", ")}</Text>
          ) : null}
          {server.errorMessage ? (
            <Text color={theme.muted}> {server.errorMessage}</Text>
          ) : null}
        </Box>
      ))}
    </CapabilitySection>
  );
}

function CronCapabilitySection(props: {
  tools: CapabilitySnapshot["tools"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`cron tools (${props.tools.length})`}
      empty="cron tool is not prepared for this host"
      count={props.tools.length}
    >
      {props.tools.map((tool) => (
        <Text key={tool.name}>
          <Text color={theme.success}>• </Text>
          {tool.name}
          {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
          {tool.origin ? (
            <Text color={theme.muted}> · {tool.origin}</Text>
          ) : null}
        </Text>
      ))}
      <Text color={theme.muted}>
        schedule records are managed through the cron command surface
      </Text>
    </CapabilitySection>
  );
}

function CapabilitySection(props: {
  title: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{props.title}</Text>
      {props.count > 0 ? props.children : <Text dimColor>{props.empty}</Text>}
    </Box>
  );
}
