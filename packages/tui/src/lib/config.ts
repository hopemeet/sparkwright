import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  CONFIG_ENV_VAR,
  DETERMINISTIC_PROVIDER,
  normalizeGroupedConfig,
  projectConfigPath,
  userConfigPath,
  type ProviderConfig,
} from "@sparkwright/host";
import type { PermissionMode } from "../state/run-controller.js";
import { mergeBindings, type Bindings } from "./keybindings.js";

export interface TuiConfigFile {
  permissionMode?: PermissionMode;
  /** Model reference "provider/model" (e.g. "openai/gpt-4o-mini"). */
  model?: string;
  /** Provider definitions, merged by key across config layers. */
  providers?: Record<string, ProviderConfig>;
  /** Path relative to the config file, or absolute. */
  workspace?: string;
  /** Host-owned capability runtime settings. The TUI accepts but does not interpret these. */
  capabilities?: Record<string, unknown>;
  /**
   * Per-action keybindings. Keys are binding names (e.g. "palette.open"),
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
}

/** Per-field origin of resolved values. Surfaced by `/config`. */
export interface SourceMap {
  permissionMode?: string;
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
}

const KNOWN_KEYS = new Set([
  "permissionMode",
  "model",
  "providers",
  "workspace",
  "capabilities",
  "keybindings",
  "theme",
  "mouse",
  // Host-only flat fields the TUI does not consume but must tolerate (the
  // grouped form normalizes into these). Listed so they are not flagged as
  // unknown; the host loader owns their validation.
  "confidentialPaths",
  "write",
  "shell",
  "runBudget",
  "maxSteps",
  "traceLevel",
  "approvals",
]);
const VALID_THEMES = ["dark", "light", "mono"];
const VALID_PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "default",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
];

async function readJson(
  path: string,
): Promise<
  | { kind: "ok"; value: unknown }
  | { kind: "missing" }
  | { kind: "error"; message: string }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    return {
      kind: "error",
      message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch (err) {
    return {
      kind: "error",
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function validateProvider(
  value: unknown,
  filePath: string,
  field: string,
  errors: ValidationError[],
): ProviderConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({ file: filePath, field, message: "must be a JSON object" });
    return null;
  }
  const obj = value as Record<string, unknown>;
  const out: ProviderConfig = {};
  if (obj.npm !== undefined) {
    if (typeof obj.npm === "string" && obj.npm.length > 0) out.npm = obj.npm;
    else
      errors.push({
        file: filePath,
        field: `${field}.npm`,
        message: "must be a non-empty string",
      });
  }
  if (obj.baseURL !== undefined) {
    if (typeof obj.baseURL === "string" && /^https?:\/\//i.test(obj.baseURL))
      out.baseURL = obj.baseURL;
    else
      errors.push({
        file: filePath,
        field: `${field}.baseURL`,
        message: "must be an http(s) URL",
      });
  }
  if (obj.apiKey !== undefined) {
    if (typeof obj.apiKey === "string" && obj.apiKey.length > 0)
      out.apiKey = obj.apiKey;
    else
      errors.push({
        file: filePath,
        field: `${field}.apiKey`,
        message: "must be a non-empty string",
      });
  }
  if (obj.models !== undefined) {
    if (
      typeof obj.models === "object" &&
      obj.models !== null &&
      !Array.isArray(obj.models)
    ) {
      out.models = obj.models as ProviderConfig["models"];
    } else {
      errors.push({
        file: filePath,
        field: `${field}.models`,
        message: "must be a JSON object",
      });
    }
  }
  return out;
}

/**
 * Validate one parsed config file against the same shape that
 * schemas/config.schema.json describes. Unknown keys produce a warning
 * error; wrong types produce a hard error and the field is dropped.
 *
 * Kept hand-rolled (no ajv dep) to match the repo pattern: schemas/ is the
 * source of truth for editors/CI, runtime validation is small and explicit.
 */
function validate(
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
  // Accept the grouped form (identity/policy/run/ui); the shared normalizer
  // flattens it to the same keys the TUI reads below. The host loader is the
  // authority on these fields, so this keeps the two readers in agreement.
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

  if (obj.model !== undefined) {
    if (typeof obj.model === "string" && obj.model.length > 0) {
      config.model = obj.model;
      sources.model = origin;
    } else {
      errors.push({
        file: filePath,
        field: "model",
        message: "must be a non-empty string",
      });
    }
  }
  if (obj.permissionMode !== undefined) {
    if (
      typeof obj.permissionMode === "string" &&
      (VALID_PERMISSION_MODES as string[]).includes(obj.permissionMode)
    ) {
      config.permissionMode = obj.permissionMode as PermissionMode;
      sources.permissionMode = origin;
    } else {
      errors.push({
        file: filePath,
        field: "permissionMode",
        message: `must be one of ${VALID_PERMISSION_MODES.join(" | ")}`,
      });
    }
  }
  if (obj.workspace !== undefined) {
    if (typeof obj.workspace === "string" && obj.workspace.length > 0) {
      config.workspace = obj.workspace;
      sources.workspace = origin;
    } else {
      errors.push({
        file: filePath,
        field: "workspace",
        message: "must be a non-empty string",
      });
    }
  }
  if (obj.providers !== undefined) {
    if (
      typeof obj.providers === "object" &&
      obj.providers !== null &&
      !Array.isArray(obj.providers)
    ) {
      const providers: Record<string, ProviderConfig> = {};
      for (const [key, value] of Object.entries(
        obj.providers as Record<string, unknown>,
      )) {
        if (key === DETERMINISTIC_PROVIDER) {
          errors.push({
            file: filePath,
            field: `providers.${key}`,
            message: `"${DETERMINISTIC_PROVIDER}" is a reserved provider key`,
          });
          continue;
        }
        const pv = validateProvider(
          value,
          filePath,
          `providers.${key}`,
          errors,
        );
        if (pv) providers[key] = pv;
      }
      config.providers = providers;
    } else {
      errors.push({
        file: filePath,
        field: "providers",
        message: "must be a JSON object",
      });
    }
  }
  if (obj.capabilities !== undefined) {
    if (
      typeof obj.capabilities === "object" &&
      obj.capabilities !== null &&
      !Array.isArray(obj.capabilities)
    ) {
      config.capabilities = obj.capabilities as Record<string, unknown>;
    } else {
      errors.push({
        file: filePath,
        field: "capabilities",
        message: "must be a JSON object",
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
  const explicit = process.env[CONFIG_ENV_VAR];
  const order: { path: string; label: string }[] = [
    { path: userConfigPath(), label: "user" },
    { path: projectConfigPath(cwd), label: "project" },
  ];
  if (explicit) {
    order.push({
      path: isAbsolute(explicit) ? explicit : resolve(cwd, explicit),
      label: "env",
    });
  }
  return order;
}

/**
 * Load + merge TUI config files. CLI args are applied by the caller (index.ts).
 */
export async function loadTuiConfig(cwd: string): Promise<LoadedTuiConfig> {
  const order = resolutionOrder(cwd);
  const merged: TuiConfigFile = {};
  const sources: SourceMap = {};
  const attempted: LoadedTuiConfig["attempted"] = [];
  const errors: ValidationError[] = [];

  // Keybindings merge layer-by-layer (later files override earlier ones per
  // binding name), so user can override project defaults of their own choice.
  let mergedBindings: Record<string, string | string[] | null> | undefined;

  for (const { path, label } of order) {
    const r = await readJson(path);
    if (r.kind === "missing") {
      attempted.push({ path, loaded: false });
      continue;
    }
    if (r.kind === "error") {
      attempted.push({ path, loaded: false });
      errors.push({ file: path, field: "(root)", message: r.message });
      continue;
    }
    attempted.push({ path, loaded: true });
    const v = validate(r.value, `${label}:${path}`, path);
    errors.push(...v.errors);
    if (v.config.workspace !== undefined) {
      v.config.workspace = isAbsolute(v.config.workspace)
        ? v.config.workspace
        : resolve(dirname(path), v.config.workspace);
    }
    if (v.config.keybindings) {
      mergedBindings = { ...(mergedBindings ?? {}), ...v.config.keybindings };
    }
    const { providers, ...rest } = v.config;
    Object.assign(merged, rest);
    if (providers) {
      merged.providers = { ...(merged.providers ?? {}), ...providers };
    }
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

  return { config: merged, sources, attempted, errors };
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
      // dir doesn't exist; we just won't catch creates here. The user can
      // /reload manually after creating the file.
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
