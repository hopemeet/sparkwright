import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
  configResolutionOrder,
  loadHostConfig,
  type ProviderConfig,
} from "@sparkwright/host";
import { mergeBindings, type Bindings } from "./keybindings.js";
import { type TuiPermissionMode } from "./permission.js";

export interface TuiConfigFile {
  /** Resolved from shared run.accessMode, not read as a TUI-owned file field. */
  tuiPermissionMode?: TuiPermissionMode;
  /** Project-layer ceiling for runtime TUI mode switches. */
  accessModeCeiling?: TuiPermissionMode;
  /** Model reference "provider/model" (e.g. "openai/gpt-4o-mini"). */
  model?: string;
  /** Provider definitions, merged by key across config layers. */
  providers?: Record<string, ProviderConfig>;
  /** Path relative to the config file, or absolute. */
  workspace?: string;
  /** Host-owned capability runtime settings. The TUI accepts but does not interpret these. */
  capabilities?: Record<string, unknown>;
  /**
   * Per-action keybindings. Keys are binding names (e.g. "help.open"),
   * values are chord strings or arrays. Empty string / [] clears the default.
   */
  keybindings?: Record<string, string | string[] | null>;
  /** Resolved (merged with defaults) — populated by loadTuiConfig, not read from disk. */
  resolvedBindings?: Bindings;
  /** Visual theme id. Known: "dark" (default), "light", "mono". */
  theme?: string;
  /**
   * Enable mouse reporting (wheel-scroll the event log). Default true.
   * Set false if your terminal's text selection conflicts with mouse mode.
   */
  mouse?: boolean;
  /** Enable vim modal editing in the input box. Default false. */
  vim?: boolean;
}

/** Per-field origin of resolved values. Surfaced by `/config`. */
export interface SourceMap {
  tuiPermissionMode?: string;
  accessModeCeiling?: string;
  model?: string;
  workspace?: string;
  theme?: string;
}

export interface ValidationError {
  /** Absolute path of the file the error came from. */
  file: string;
  /** Dot-path inside the JSON document, e.g. "provider". */
  field: string;
  message: string;
}

export interface LoadedTuiConfig {
  config: TuiConfigFile;
  sources: SourceMap;
  /** Files we tried (in resolution order) and whether they were loaded. */
  attempted: { path: string; loaded: boolean }[];
  /** Validation problems. Bad fields are dropped from `config`. */
  errors: ValidationError[];
  /** Non-fatal config diagnostics such as access-mode clamping. */
  warnings: ValidationError[];
}

function resolutionOrder(cwd: string): { path: string; label: string }[] {
  return configResolutionOrder(cwd, process.env);
}

/**
 * Load + merge TUI config files. CLI args are applied by the caller (index.ts).
 */
export async function loadTuiConfig(cwd: string): Promise<LoadedTuiConfig> {
  const shared = await loadHostConfig(cwd, process.env);
  const merged: TuiConfigFile = {
    tuiPermissionMode: shared.config.accessMode as
      | TuiPermissionMode
      | undefined,
    accessModeCeiling: shared.config.accessModeCeiling as
      | TuiPermissionMode
      | undefined,
    model: shared.config.model,
    providers: shared.config.providers,
    workspace: shared.config.workspace,
    capabilities: shared.config.capabilities as
      | Record<string, unknown>
      | undefined,
    keybindings: shared.config.keybindings,
    theme: shared.config.theme,
    mouse: shared.config.mouse,
    vim: shared.config.vim,
  };
  const sources: SourceMap = {
    tuiPermissionMode: shared.sources.accessMode,
    accessModeCeiling: shared.sources.accessModeCeiling,
    model: shared.sources.model,
    workspace: shared.sources.workspace,
    theme: shared.sources.theme,
  };
  const attempted: LoadedTuiConfig["attempted"] = shared.attempted.map(
    (entry) => ({ path: entry.path, loaded: entry.loaded }),
  );
  const errors: ValidationError[] = [...shared.errors];
  const warnings: ValidationError[] = [...shared.warnings];

  // Resolve final bindings (defaults + user overrides). Bad chord strings
  // become validation errors with a synthetic file path.
  const resolved = mergeBindings(merged.keybindings);
  for (const e of resolved.errors) {
    errors.push({
      file: "(keybindings)",
      field: e.name,
      message: e.message,
    });
  }
  merged.resolvedBindings = resolved.bindings;

  return { config: merged, sources, attempted, errors, warnings };
}

/**
 * Watch every file in the resolution order and call onChange (debounced) when
 * any of them is created / modified / removed. Returns a disposer.
 */
export function watchTuiConfig(cwd: string, onChange: () => void): () => void {
  const order = resolutionOrder(cwd);
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 150);
  };

  for (const { path } of order) {
    // Watching the file directly throws if it does not yet exist, so watch the
    // parent directory and filter by filename. This also catches create/delete.
    const dir = dirname(path);
    const name = path.slice(dir.length + 1);
    try {
      const w = watch(dir, (_event, changed) => {
        if (!changed || changed === name) trigger();
      });
      w.on("error", () => {
        /* dir might not exist — ignore */
      });
      // Don't keep the Node event loop alive just for config watching — this
      // matters in non-TTY smoke tests / CI where the process should exit
      // when its real work is done.
      w.unref?.();
      watchers.push(w);
    } catch {
      // dir doesn't exist; we just won't catch creates here. Startup and the
      // next watcher event will pick up future files.
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
