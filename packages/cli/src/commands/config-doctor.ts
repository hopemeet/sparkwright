import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import {
  configResolutionOrder,
  loadHostConfig,
  readConfigFileObject,
  resolveCapabilityDirs,
} from "@sparkwright/host";
import { defaultCronRoot } from "@sparkwright/cron";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";
import { isPlainObject, splitCliWords } from "../parser/values.js";
import type { CliRunResult, ParsedArgs } from "./contracts.js";
import {
  defaultTaskRoot,
  preferredProjectConfigPathForWorkspace,
  preferredUserConfigPath,
} from "./config-paths.js";

export function configUsage(): string {
  return [
    "Usage: sparkwright config path [--workspace path] [--format json|text]",
    "       sparkwright config validate [--workspace path] [--format json|text]",
    "       sparkwright config inspect [--workspace path] [--format json|text]",
    "       sparkwright config explain [--workspace path] [--format json|text]",
    `       sparkwright config example <${CONFIG_EXAMPLE_NAMES.join("|")}>`,
  ].join("\n");
}

export function doctorUsage(): string {
  return "Usage: sparkwright doctor paths [--workspace path] [--session-root path] [--format json|text]";
}

export async function handleConfigCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  switch (parsed.subcommand) {
    case "path":
      return handleConfigPath(parsed, io, env);
    case "validate":
      return handleConfigValidate(parsed, io, env);
    case "inspect":
      return handleConfigInspect(parsed, io, env);
    case "explain":
      return handleConfigExplain(parsed, io, env);
    case "example":
      return handleConfigExample(parsed, io);
    default:
      writeLine(io.stderr, configUsage());
      return { exitCode: 1 };
  }
}

export async function handleDoctorCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (parsed.subcommand !== "paths") {
    writeLine(io.stderr, doctorUsage());
    return { exitCode: 1 };
  }

  const report = buildDoctorPathsReport(parsed, env);
  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(report, null, 2)
      : formatDoctorPathsReport(report),
  );
  return { exitCode: 0 };
}

interface DoctorPathsReport {
  executable?: string;
  node: {
    executable: string;
    version: string;
  };
  install: {
    root: string;
    bin: string;
    current: string;
    version?: string;
    currentTarget?: string;
    inferredFromExecutable?: string;
    entrypoints: {
      cli: string;
      tui: string;
      acp: string;
    };
  };
  config: {
    user: string;
    project: string;
    envOverride?: string;
  };
  capabilities: {
    skills: LayerPathEntry[];
    agents: LayerPathEntry[];
    command: LayerPathEntry[];
    mcp: { source: "config"; user: string; project: string };
    acp: { source: "entrypoint-and-config"; delegateConfig: string };
  };
  state: {
    user: string;
    hostCrashes: string;
    cron: { root: string };
    imGateway: {
      config: string;
      dataDir: string;
    };
  };
  workspace: {
    root: string;
    sessionRoot: string;
    tasksRoot: string;
    exportsRoot: string;
  };
}

interface LayerPathEntry {
  layer: string;
  path: string;
  readOnly?: boolean;
}

function buildDoctorPathsReport(
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
): DoctorPathsReport {
  const executable = process.argv[1];
  const installRoot =
    (executable ? inferInstallRoot(executable) : undefined) ??
    join(homedir(), ".sparkwright");
  const installBin = installEntrypoint(installRoot);
  const installSource = executable ? inferInstallSource(executable) : undefined;
  const installVersion =
    installSource === "sparkwright"
      ? inferInstallVersion(executable, installRoot)
      : undefined;
  const currentTarget =
    installSource === "sparkwright"
      ? readInstallCurrentTarget(installRoot)
      : undefined;
  const userStateRoot = userStateBase(env);
  const projectConfig = preferredProjectConfigPathForWorkspace(
    parsed.workspaceRoot,
  );
  const configEnvOverride = env.SPARKWRIGHT_CONFIG;
  return {
    ...(executable ? { executable } : {}),
    node: {
      executable: process.execPath,
      version: process.version,
    },
    install: {
      root: installRoot,
      bin: join(installRoot, "bin"),
      current: join(installRoot, "current"),
      ...(installVersion ? { version: installVersion } : {}),
      ...(currentTarget ? { currentTarget } : {}),
      ...(executable
        ? { inferredFromExecutable: installSource ?? "unknown" }
        : {}),
      entrypoints: {
        cli: installBin,
        tui: `${installBin} tui`,
        acp: `${installBin} acp`,
      },
    },
    config: {
      user: preferredUserConfigPath(env),
      project: projectConfig,
      ...(configEnvOverride ? { envOverride: configEnvOverride } : {}),
    },
    capabilities: {
      skills: resolveCapabilityDirs("skills", {
        cwd: parsed.workspaceRoot,
        env,
      }).map(layerPathEntry),
      agents: resolveCapabilityDirs("agents", {
        cwd: parsed.workspaceRoot,
        env,
      }).map(layerPathEntry),
      command: resolveCapabilityDirs("command", {
        cwd: parsed.workspaceRoot,
        env,
      }).map(layerPathEntry),
      mcp: {
        source: "config",
        user: preferredUserConfigPath(env),
        project: projectConfig,
      },
      acp: {
        source: "entrypoint-and-config",
        delegateConfig:
          "capabilities.agents.profiles[].metadata.acp + capabilities.agents.delegateTools[]",
      },
    },
    state: {
      user: userStateRoot,
      hostCrashes: join(userStateRoot, "sparkwright", "host-crashes"),
      cron: {
        root: defaultCronRoot(env),
      },
      imGateway: {
        config: imGatewayConfigPath(env),
        dataDir: imGatewayDataDir(env),
      },
    },
    workspace: {
      root: parsed.workspaceRoot,
      sessionRoot: parsed.sessionRootDir,
      tasksRoot: defaultTaskRoot(parsed.workspaceRoot),
      exportsRoot: join(parsed.workspaceRoot, ".sparkwright", "exports"),
    },
  };
}

function layerPathEntry(input: {
  layer: string;
  dir: string;
  readOnly?: boolean;
}): LayerPathEntry {
  return {
    layer: input.layer,
    path: input.dir,
    ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
  };
}

function formatDoctorPathsReport(report: DoctorPathsReport): string {
  const lines = [
    `executable: ${report.executable ?? "(unknown)"}`,
    `node: ${report.node.executable} (${report.node.version})`,
    `install root: ${report.install.root}`,
    `install bin: ${report.install.bin}`,
    `install current: ${report.install.current}`,
    `install source: ${report.install.inferredFromExecutable ?? "unknown"}`,
    `install version: ${report.install.version ?? "(unknown)"}`,
    `install current target: ${report.install.currentTarget ?? "(unknown)"}`,
    `cli entrypoint: ${report.install.entrypoints.cli}`,
    `tui entrypoint: ${report.install.entrypoints.tui}`,
    `acp entrypoint: ${report.install.entrypoints.acp}`,
    `user config: ${report.config.user}`,
    `project config: ${report.config.project}`,
  ];
  if (report.config.envOverride) {
    lines.push(`env config override: ${report.config.envOverride}`);
  }
  lines.push(
    "skill roots:",
    ...report.capabilities.skills.map(formatLayerPath),
    "agent roots:",
    ...report.capabilities.agents.map(formatLayerPath),
    "command dirs:",
    ...report.capabilities.command.map(formatLayerPath),
    `mcp source: ${report.capabilities.mcp.source} (${report.capabilities.mcp.user}, ${report.capabilities.mcp.project})`,
    `acp source: ${report.capabilities.acp.source} (${report.capabilities.acp.delegateConfig})`,
    `user state: ${report.state.user}`,
    `host crash state: ${report.state.hostCrashes}`,
    `cron state: ${report.state.cron.root}`,
    `im gateway config: ${report.state.imGateway.config}`,
    `im gateway state: ${report.state.imGateway.dataDir}`,
    `workspace: ${report.workspace.root}`,
    `session root: ${report.workspace.sessionRoot}`,
    `tasks root: ${report.workspace.tasksRoot}`,
    `exports root: ${report.workspace.exportsRoot}`,
  );
  return lines.join("\n");
}

function formatLayerPath(entry: LayerPathEntry): string {
  return `  - ${entry.layer}: ${entry.path}${entry.readOnly ? " (read-only)" : ""}`;
}

function installEntrypoint(installRoot: string): string {
  return join(
    installRoot,
    "bin",
    process.platform === "win32" ? "sparkwright.cmd" : "sparkwright",
  );
}

function inferInstallSource(executable: string): string {
  const normalized = executable.split(sep).join("/");
  if (
    normalized.includes("/.sparkwright/versions/") ||
    normalized.includes("/versions/") ||
    normalized.includes("/current/app/node_modules/@sparkwright/cli/")
  ) {
    return "sparkwright";
  }
  if (normalized.includes("/node_modules/@sparkwright/cli/")) return "npm";
  if (normalized.includes("/packages/cli/")) return "source";
  return "unknown";
}

function inferInstallRoot(executable: string): string | undefined {
  const currentMarker = `${sep}current${sep}app${sep}node_modules${sep}@sparkwright${sep}cli${sep}`;
  const currentIndex = executable.indexOf(currentMarker);
  if (currentIndex >= 0) return executable.slice(0, currentIndex);

  const versionsMarker = `${sep}versions${sep}`;
  const appMarker = `${sep}app${sep}node_modules${sep}@sparkwright${sep}cli${sep}`;
  const versionsIndex = executable.indexOf(versionsMarker);
  const appIndex = executable.indexOf(appMarker);
  if (versionsIndex >= 0 && appIndex > versionsIndex) {
    return executable.slice(0, versionsIndex);
  }
  return undefined;
}

function inferInstallVersion(
  executable: string | undefined,
  installRoot: string,
): string | undefined {
  if (executable) {
    const versionsMarker = `${sep}versions${sep}`;
    const appMarker = `${sep}app${sep}node_modules${sep}@sparkwright${sep}cli${sep}`;
    const versionsIndex = executable.indexOf(versionsMarker);
    const appIndex = executable.indexOf(appMarker);
    if (versionsIndex >= 0 && appIndex > versionsIndex) {
      return executable.slice(versionsIndex + versionsMarker.length, appIndex);
    }
  }

  const currentTarget = readInstallCurrentTarget(installRoot);
  if (!currentTarget) return undefined;
  const normalized = currentTarget.split(sep).join("/");
  const match = normalized.match(/(?:^|\/)versions\/([^/]+)$/);
  return match?.[1] ?? basename(currentTarget);
}

function readInstallCurrentTarget(installRoot: string): string | undefined {
  try {
    return readlinkSync(join(installRoot, "current"));
  } catch {
    return undefined;
  }
}

function userStateBase(env: Record<string, string | undefined>): string {
  return env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
}

function imGatewayConfigPath(env: Record<string, string | undefined>): string {
  const configBase =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configBase, "sparkwright", "im-gateway.json");
}

function imGatewayDataDir(env: Record<string, string | undefined>): string {
  return join(userStateBase(env), "sparkwright", "im-gateway");
}

async function handleConfigPath(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const order = configResolutionOrder(parsed.workspaceRoot, env);
  const loaded = await loadHostConfig(parsed.workspaceRoot, env);
  const loadedByPath = new Map(
    loaded.attempted.map((entry) => [entry.path, entry.loaded]),
  );
  const layers = order.map(({ path, label }) => ({
    label,
    path,
    loaded: loadedByPath.get(path) ?? false,
  }));
  if (parsed.format === "json") {
    writeLine(io.stdout, JSON.stringify({ layers }, null, 2));
  } else {
    writeLine(io.stdout, "Config resolution order (later overrides earlier):");
    for (const layer of layers) {
      writeLine(
        io.stdout,
        `  ${layer.loaded ? "[loaded] " : "[absent] "}${layer.label}: ${layer.path}`,
      );
    }
  }
  return { exitCode: 0 };
}

async function handleConfigValidate(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const loaded = await loadHostConfig(parsed.workspaceRoot, env);
  const loadedCount = loaded.attempted.filter((entry) => entry.loaded).length;
  const schemaReport = await validateLoadedConfigFilesAgainstSchema(loaded);
  const errors = [...loaded.errors, ...schemaReport.errors];

  if (parsed.format === "json") {
    writeLine(
      io.stdout,
      JSON.stringify(
        {
          ok: errors.length === 0,
          filesLoaded: loadedCount,
          schemaFilesChecked: schemaReport.filesChecked,
          schemaPath: schemaReport.schemaPath,
          loadErrors: loaded.errors,
          warnings: loaded.warnings,
          schemaErrors: schemaReport.errors,
          errors,
        },
        null,
        2,
      ),
    );
  } else if (errors.length === 0) {
    writeLine(
      io.stdout,
      `Config OK (${loadedCount} file(s) loaded, ${schemaReport.filesChecked} schema-checked).`,
    );
    for (const warning of loaded.warnings) {
      writeLine(
        io.stdout,
        `  warning: ${warning.file} (${warning.field}): ${warning.message}`,
      );
    }
  } else {
    writeLine(
      io.stdout,
      `${errors.length} problem(s) across ${loadedCount} loaded file(s), ${schemaReport.filesChecked} schema-checked file(s):`,
    );
    for (const error of errors) {
      writeLine(
        io.stdout,
        `  ${error.file} (${error.field}): ${error.message}`,
      );
    }
  }
  return { exitCode: errors.length > 0 ? 1 : 0 };
}

type ConfigDiagnostic = Awaited<
  ReturnType<typeof loadHostConfig>
>["errors"][number];

interface ConfigSchemaValidator {
  schemaPath: string;
  validate: ValidateFunction;
}

let cachedConfigSchemaValidator: ConfigSchemaValidator | undefined;

async function validateLoadedConfigFilesAgainstSchema(
  loaded: Awaited<ReturnType<typeof loadHostConfig>>,
): Promise<{
  schemaPath?: string;
  filesChecked: number;
  errors: ConfigDiagnostic[];
}> {
  let validator: ConfigSchemaValidator;
  try {
    validator = loadConfigSchemaValidator();
  } catch (error) {
    return {
      filesChecked: 0,
      errors: [
        {
          file: "(schema)",
          field: "(root)",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const errors: ConfigDiagnostic[] = [];
  let filesChecked = 0;
  for (const entry of loaded.attempted) {
    if (!entry.loaded) continue;
    try {
      const configFile = await readConfigFileObject(entry.path);
      filesChecked += 1;
      if (validator.validate(configFile.value)) continue;
      for (const error of validator.validate.errors ?? []) {
        errors.push(formatConfigSchemaError(entry.path, error));
      }
    } catch {
      // Parse/read failures are already reported by loadHostConfig.
    }
  }

  return { schemaPath: validator.schemaPath, filesChecked, errors };
}

function loadConfigSchemaValidator(): ConfigSchemaValidator {
  if (cachedConfigSchemaValidator) return cachedConfigSchemaValidator;

  const schemaDir = findConfigSchemaDir();
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    validateSchema: true,
  });
  ajv.addKeyword({
    keyword: "x-sparkwrightProtocolVersion",
    metaSchema: { type: "string" },
  });

  const schemaFiles = readdirSync(schemaDir)
    .filter((file) => file.endsWith(".schema.json"))
    .sort();
  for (const file of schemaFiles) {
    const schemaPath = join(schemaDir, file);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
    ajv.addSchema(schema, file);
  }

  const validate = ajv.getSchema("config.schema.json");
  if (!validate) {
    throw new Error(`config.schema.json was not found in ${schemaDir}`);
  }

  cachedConfigSchemaValidator = {
    schemaPath: join(schemaDir, "config.schema.json"),
    validate,
  };
  return cachedConfigSchemaValidator;
}

export function findConfigSchemaDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "schemas"),
    resolve(here, "..", "..", "..", "..", "schemas"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "config.schema.json"))) return candidate;
  }
  throw new Error(
    `config schema files not found (looked in ${candidates.join(", ")})`,
  );
}

function formatConfigSchemaError(
  file: string,
  error: ErrorObject,
): ConfigDiagnostic {
  const field = schemaErrorField(error);
  return {
    file,
    field,
    message: `schema: ${formatAjvMessage(error)}`,
  };
}

function schemaErrorField(error: ErrorObject): string {
  const base = jsonPointerToField(error.instancePath);
  if (
    error.keyword === "additionalProperties" &&
    isPlainObject(error.params) &&
    typeof error.params.additionalProperty === "string"
  ) {
    return base === "(root)"
      ? error.params.additionalProperty
      : `${base}.${error.params.additionalProperty}`;
  }
  return base;
}

function jsonPointerToField(pointer: string): string {
  if (!pointer) return "(root)";
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : part))
    .join(".")
    .replace(/\.\[/g, "[");
}

function formatAjvMessage(error: ErrorObject): string {
  const message = error.message ?? "schema validation failed";
  if (
    error.keyword === "enum" &&
    isPlainObject(error.params) &&
    Array.isArray(error.params.allowedValues)
  ) {
    return `${message}: ${error.params.allowedValues.join(" | ")}`;
  }
  return message;
}

async function handleConfigInspect(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const loaded = await loadHostConfig(parsed.workspaceRoot, env);
  const report = buildConfigInspectReport(loaded);
  if (parsed.format === "json") {
    writeLine(io.stdout, JSON.stringify(report, null, 2));
  } else {
    writeLine(io.stdout, formatConfigInspectReport(report));
  }
  return { exitCode: loaded.errors.length > 0 ? 1 : 0 };
}

async function handleConfigExplain(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const loaded = await loadHostConfig(parsed.workspaceRoot, env);
  const report = buildConfigInspectReport(loaded);
  if (parsed.format === "json") {
    writeLine(
      io.stdout,
      JSON.stringify(
        {
          ok: report.ok,
          layers: report.layers,
          fields: report.fields,
          errors: report.errors,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    );
  } else {
    writeLine(io.stdout, formatConfigExplainReport(report));
  }
  return { exitCode: loaded.errors.length > 0 ? 1 : 0 };
}

function buildConfigInspectReport(
  loaded: Awaited<ReturnType<typeof loadHostConfig>>,
): {
  ok: boolean;
  layers: Array<{ path: string; loaded: boolean }>;
  config: unknown;
  sources: Awaited<ReturnType<typeof loadHostConfig>>["sources"];
  fields: Array<{ field: string; source: string; value?: unknown }>;
  errors: Awaited<ReturnType<typeof loadHostConfig>>["errors"];
  warnings: Awaited<ReturnType<typeof loadHostConfig>>["warnings"];
} {
  return {
    ok: loaded.errors.length === 0,
    layers: loaded.attempted,
    config: redactConfigForDisplay(loaded.config),
    sources: loaded.sources,
    fields: describeConfigFields(loaded),
    errors: loaded.errors,
    warnings: loaded.warnings,
  };
}

function describeConfigFields(
  loaded: Awaited<ReturnType<typeof loadHostConfig>>,
): Array<{ field: string; source: string; value?: unknown }> {
  const config = loaded.config;
  const sources = loaded.sources;
  const fields: Array<{ field: string; source: string; value?: unknown }> = [];
  const add = (field: string, source: string | undefined, value: unknown) => {
    if (value === undefined) return;
    fields.push({
      field,
      source: source ?? "default",
      value: redactConfigForDisplay(value),
    });
  };

  add("model", sources.model, config.model);
  add("accessMode", sources.accessMode, config.accessMode);
  add("accessModeCeiling", sources.accessModeCeiling, config.accessModeCeiling);
  add("backgroundTasks", sources.backgroundTasks, config.backgroundTasks);
  add(
    "backgroundTasksCeiling",
    sources.backgroundTasksCeiling,
    config.backgroundTasksCeiling,
  );
  add("workspace", sources.workspace, config.workspace);
  add(
    "confidentialDefaults",
    sources.confidentialDefaults,
    config.confidentialDefaults,
  );
  add("confidentialPaths", sources.confidentialPaths, config.confidentialPaths);
  add("write", sources.write, config.write);
  add("shell", sources.shell, config.shell);
  add("tools", sources.tools, config.tools);
  add("runBudget", sources.runBudget, config.runBudget);
  add("maxSteps", sources.maxSteps, config.maxSteps);
  add("traceLevel", sources.traceLevel, config.traceLevel);
  for (const key of Object.keys(config.providers ?? {}).sort()) {
    add(`providers.${key}`, sources.providers?.[key], config.providers?.[key]);
  }
  return fields;
}

function redactConfigForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigForDisplay);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretConfigKey(key)) {
      out[key] = "<redacted>";
    } else {
      out[key] = redactConfigForDisplay(entry);
    }
  }
  return out;
}

function isSecretConfigKey(key: string): boolean {
  return /api[_-]?key|token|secret|password/i.test(key);
}

function formatConfigInspectReport(
  report: ReturnType<typeof buildConfigInspectReport>,
): string {
  return [
    report.ok ? "Config OK." : `Config has ${report.errors.length} problem(s).`,
    "Layers:",
    ...report.layers.map(
      (layer) => `  ${layer.loaded ? "[loaded] " : "[absent] "}${layer.path}`,
    ),
    "Effective config:",
    JSON.stringify(report.config, null, 2),
    ...(report.errors.length > 0
      ? [
          "Errors:",
          ...report.errors.map(
            (error) => `  ${error.file} (${error.field}): ${error.message}`,
          ),
        ]
      : []),
    ...(report.warnings.length > 0
      ? [
          "Warnings:",
          ...report.warnings.map(
            (warning) =>
              `  ${warning.file} (${warning.field}): ${warning.message}`,
          ),
        ]
      : []),
  ].join("\n");
}

function formatConfigExplainReport(
  report: ReturnType<typeof buildConfigInspectReport>,
): string {
  const lines = [
    report.ok ? "Config OK." : `Config has ${report.errors.length} problem(s).`,
    "Layers:",
    ...report.layers.map(
      (layer) => `  ${layer.loaded ? "[loaded] " : "[absent] "}${layer.path}`,
    ),
    "Fields:",
  ];
  if (report.fields.length === 0) {
    lines.push("  (none configured; built-in defaults apply)");
  } else {
    for (const field of report.fields) {
      lines.push(
        `  ${field.field}: ${field.source} = ${formatConfigFieldValue(field.value)}`,
      );
    }
  }
  if (report.errors.length > 0) {
    lines.push(
      "Errors:",
      ...report.errors.map(
        (error) => `  ${error.file} (${error.field}): ${error.message}`,
      ),
    );
  }
  if (report.warnings.length > 0) {
    lines.push(
      "Warnings:",
      ...report.warnings.map(
        (warning) => `  ${warning.file} (${warning.field}): ${warning.message}`,
      ),
    );
  }
  return lines.join("\n");
}

function formatConfigFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function handleConfigExample(parsed: ParsedArgs, io: CliIO): CliRunResult {
  const name = splitCliWords(parsed.goal)[0];
  if (!name) {
    writeLine(io.stderr, configUsage());
    return { exitCode: 1 };
  }
  const example = CONFIG_EXAMPLES[name];
  if (!example) {
    writeLine(
      io.stderr,
      `Unknown example "${name}". Available: ${CONFIG_EXAMPLE_NAMES.join(", ")}.`,
    );
    return { exitCode: 1 };
  }
  writeLine(io.stdout, `${JSON.stringify(example, null, 2)}`);
  return { exitCode: 0 };
}

/**
 * Paste-ready config snippets for `sparkwright config example <name>`, in the
 * preferred grouped form. These mirror the recipes in
 * docs/guides/CONFIGURATION.md so the guide's examples are reachable in-product.
 */
const CONFIG_EXAMPLES: Record<string, unknown> = {
  write: {
    policy: {
      write: { maxFiles: 1, maxDiffLines: 200, allowDeletions: false },
    },
  },
  sandbox: {
    policy: {
      sandbox: {
        mode: "warn",
        filesystem: { denyRead: [".env", ".ssh", ".aws"] },
        network: { mode: "deny" },
      },
    },
  },
  run: {
    run: {
      accessMode: "ask",
      budget: { maxModelCalls: 50, maxToolCalls: 100 },
      traceLevel: "standard",
    },
  },
  hooks: {
    capabilities: {
      hooks: {
        workflow: [
          {
            name: "block-generated",
            hook: "PreToolUse",
            matcher: {
              toolName: ["write", "edit_anchored_text", "edit"],
              pathGlob: "src/generated/**",
            },
            action: {
              type: "block",
              reason: "Generated files are build output.",
            },
          },
        ],
      },
    },
  },
  verification: {
    capabilities: {
      verification: {
        mode: "require",
        defaultProfile: "default",
        profiles: {
          default: [
            { id: "test", kind: "test", command: "npm", args: ["test"] },
          ],
        },
      },
    },
  },
  mcp: {
    capabilities: {
      mcp: {
        servers: [
          {
            type: "stdio",
            name: "example",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
          },
        ],
      },
    },
  },
  agent: {
    capabilities: {
      agents: {
        profiles: [
          {
            id: "reviewer",
            mode: "child",
            prompt: "Review the diff for correctness and clarity.",
          },
        ],
        delegateTools: [{ profileId: "reviewer", toolName: "review_changes" }],
      },
    },
  },
};

const CONFIG_EXAMPLE_NAMES = Object.keys(CONFIG_EXAMPLES);
