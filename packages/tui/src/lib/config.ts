import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
  configResolutionOrder,
  loadHostConfig,
  normalizeGroupedConfig,
  readConfigFileObject,
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

const KNOWN_KEYS = new Set([
  "accessMode",
  "model",
  "providers",
  "workspace",
  "capabilities",
  "tools",
  "keybindings",
  "theme",
  "mouse",
  "vim",
  // Host-only flat fields the TUI does not consume but must tolerate (the
  // grouped form normalizes into these). Listed so they are not flagged as
  // unknown; the host loader owns their validation.
  "confidentialDefaults",
  "confidentialPaths",
  "write",
  "shell",
  "runBudget",
  "maxSteps",
  "traceLevel",
]);
const VALID_THEMES = ["dark", "light", "mono"];
/**
 * Validate only TUI-owned fields. Shared fields (model, providers,
 * accessMode, capabilities, tools, shell, etc.) are loaded by
 * @sparkwright/host so the TUI cannot drift from CLI/host semantics.
 */
function validateUiOverlay(
  raw: unknown,
  origin: string,
  filePath: string,
): { config: TuiConfigFile; sources: SourceMap; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const config: TuiConfigFile = {};
  const sources: SourceMap = {};

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      file: filePath,
      field: "(root)",
      message: "must be a JSON object",
    });
    return { config, sources, errors };
  }
  // Accept grouped config so ui.theme/keybindings/mouse normalize to the same
  // flat fields the rest of the TUI reads. Shared grouped fields are normalized
  // too but intentionally ignored here; host validation owns them.
  const obj = normalizeGroupedConfig(
    raw as Record<string, unknown>,
    filePath,
    errors,
  );

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push({
        file: filePath,
        field: key,
        message: `unknown field (allowed: ${[...KNOWN_KEYS].join(", ")})`,
      });
    }
  }

  if (obj.theme !== undefined) {
    if (typeof obj.theme === "string" && VALID_THEMES.includes(obj.theme)) {
      config.theme = obj.theme;
      sources.theme = origin;
    } else {
      errors.push({
        file: filePath,
        field: "theme",
        message: `must be one of ${VALID_THEMES.join(" | ")}`,
      });
    }
  }
  if (obj.mouse !== undefined) {
    if (typeof obj.mouse === "boolean") {
      config.mouse = obj.mouse;
    } else {
      errors.push({
        file: filePath,
        field: "mouse",
        message: "must be a boolean",
      });
    }
  }
  if (obj.vim !== undefined) {
    if (typeof obj.vim === "boolean") {
      config.vim = obj.vim;
    } else {
      errors.push({
        file: filePath,
        field: "vim",
        message: "must be a boolean",
      });
    }
  }
  if (obj.keybindings !== undefined) {
    if (
      typeof obj.keybindings === "object" &&
      obj.keybindings !== null &&
      !Array.isArray(obj.keybindings)
    ) {
      const ok: Record<string, string | string[] | null> = {};
      for (const [k, v] of Object.entries(
        obj.keybindings as Record<string, unknown>,
      )) {
        if (v === null || typeof v === "string") {
          ok[k] = v;
        } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
          ok[k] = v as string[];
        } else {
          errors.push({
            file: filePath,
            field: `keybindings.${k}`,
            message: "must be a string, string[], or null",
          });
        }
      }
      config.keybindings = ok;
    } else {
      errors.push({
        file: filePath,
        field: "keybindings",
        message: "must be a JSON object",
      });
    }
  }
  return { config, sources, errors };
}

function resolutionOrder(cwd: string): { path: string; label: string }[] {
  return configResolutionOrder(cwd, process.env);
}

/**
 * Load + merge TUI config files. CLI args are applied by the caller (index.ts).
 */
export async function loadTuiConfig(cwd: string): Promise<LoadedTuiConfig> {
  const shared = await loadHostConfig(cwd, process.env);
  const order = resolutionOrder(cwd);
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
  };
  const sources: SourceMap = {
    tuiPermissionMode: shared.sources.accessMode,
    accessModeCeiling: shared.sources.accessModeCeiling,
    model: shared.sources.model,
    workspace: shared.sources.workspace,
  };
  const attempted: LoadedTuiConfig["attempted"] = shared.attempted.map(
    (entry) => ({ path: entry.path, loaded: entry.loaded }),
  );
  const errors: ValidationError[] = [...shared.errors];
  const warnings: ValidationError[] = [...shared.warnings];

  // Keybindings merge layer-by-layer (later files override earlier ones per
  // binding name), so user can override project defaults of their own choice.
  let mergedBindings: Record<string, string | string[] | null> | undefined;

  const labelByPath = new Map(order.map((entry) => [entry.path, entry.label]));
  for (const { path, loaded } of attempted) {
    if (!loaded) continue;
    let value: Record<string, unknown>;
    try {
      value = (await readConfigFileObject(path)).value;
    } catch (error) {
      errors.push({
        file: path,
        field: "(root)",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const label = labelByPath.get(path) ?? "config";
    const v = validateUiOverlay(value, `${label}:${path}`, path);
    errors.push(...v.errors);
    if (v.config.keybindings) {
      mergedBindings = { ...(mergedBindings ?? {}), ...v.config.keybindings };
    }
    if (v.config.theme !== undefined) merged.theme = v.config.theme;
    if (v.config.mouse !== undefined) merged.mouse = v.config.mouse;
    if (v.config.vim !== undefined) merged.vim = v.config.vim;
    Object.assign(sources, v.sources);
  }

  // Resolve final bindings (defaults + user overrides). Bad chord strings
  // become validation errors with a synthetic file path.
  const resolved = mergeBindings(mergedBindings);
  for (const e of resolved.errors) {
    errors.push({
      file: "(keybindings)",
      field: e.name,
      message: e.message,
    });
  }
  merged.keybindings = mergedBindings;
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
