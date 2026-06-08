import { readFile } from "node:fs/promises";
import type { ModelAdapter } from "@sparkwright/core";
import {
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  resolveModelSelection,
} from "./config.js";
import {
  buildConfiguredAdapter,
  type ProviderRuntimeSources,
} from "./model-builder.js";

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL_JSON_ENV = "SPARKWRIGHT_SCRIPTED_MODEL_JSON";
const SCRIPTED_MODEL_FILE_ENV = "SPARKWRIGHT_SCRIPTED_MODEL_FILE";

export interface ModelFactoryInput {
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  modelRef?: string;
  goal: string;
  /** Workspace root used to resolve the project-level config layer. */
  workspaceRoot: string;
  /** Workspace-relative target path for deterministic/local smoke models. */
  targetPath?: string;
  env?: Record<string, string | undefined>;
}

export interface ConfigSourceRef {
  layer: "request" | "user" | "project" | "env" | "default" | "unknown";
  path?: string;
}

export interface ResolvedModelConfig {
  modelRef: string;
  providerKey: string;
  modelId: string;
  adapterId: string;
  modelSource: ConfigSourceRef;
  providerSource?: ConfigSourceRef;
  /** @reserved Trace/reporting field consumed by CLI, TUI, and diagnostics. */
  authSource?: string;
  /** @reserved Trace/reporting field consumed by CLI, TUI, and diagnostics. */
  baseURLSource?: string;
}

/**
 * Build the model adapter for a run. The host is the config authority: it
 * loads the merged shared config (user → project → env) and resolves the
 * "provider/model" ref against the providers map, so the parent process need
 * not bridge credentials through env. Provider credentials come from config,
 * with the provider's standard env var as a fallback/override.
 */
export async function createModel(
  input: ModelFactoryInput,
): Promise<
  | { ok: true; adapter: ModelAdapter; resolved: ResolvedModelConfig }
  | { ok: false; message: string }
> {
  const env = input.env ?? process.env;
  const loaded = await loadHostConfig(input.workspaceRoot, env);
  const ref = input.modelRef ?? loaded.config.model ?? DETERMINISTIC_PROVIDER;
  const modelSource = input.modelRef
    ? ({ layer: "request" } as const)
    : (sourceRef(loaded.sources.model) ?? ({ layer: "default" } as const));
  const targetPath = input.targetPath ?? "README.md";

  if (ref === DETERMINISTIC_PROVIDER) {
    return {
      ok: true,
      adapter: createDemoModel(input.goal, targetPath),
      resolved: deterministicResolvedModel(ref, modelSource),
    };
  }

  if (ref === SCRIPTED_PROVIDER || ref.startsWith(`${SCRIPTED_PROVIDER}/`)) {
    const scripted = await createScriptedModel(ref, env);
    if (!scripted.ok) return scripted;
    return {
      ok: true,
      adapter: scripted.adapter,
      resolved: {
        modelRef: ref,
        providerKey: SCRIPTED_PROVIDER,
        modelId: ref.includes("/")
          ? ref.slice(ref.indexOf("/") + 1)
          : "default",
        adapterId: SCRIPTED_PROVIDER,
        modelSource,
      },
    };
  }

  const selection = resolveModelSelection(loaded.config, ref);
  if (selection.kind === "deterministic") {
    return {
      ok: true,
      adapter: createDemoModel(input.goal, targetPath),
      resolved: deterministicResolvedModel(ref, modelSource),
    };
  }
  if (selection.kind === "error") {
    return { ok: false, message: selection.message };
  }
  const built = await buildConfiguredAdapter({ selection, env });
  if (!built.ok) return built;
  return {
    ok: true,
    adapter: built.adapter,
    resolved: configuredResolvedModel({
      modelRef: ref,
      providerKey: selection.providerKey,
      modelId: selection.modelId,
      modelSource,
      providerSource: sourceRef(
        loaded.sources.providers?.[selection.providerKey],
      ),
      runtimeSources: built.sources,
    }),
  };
}

/** Two-turn deterministic model used for protocol smoke tests and TUI demos. */
function createDemoModel(goal: string, targetPath: string): ModelAdapter {
  let turn = 0;
  return {
    id: DETERMINISTIC_PROVIDER,
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          message: `Inspecting ${targetPath} for goal: "${goal}"`,
          toolCalls: [
            { toolName: "read_file", arguments: { path: targetPath } },
          ],
        };
      }
      return {
        message: `Done — would proceed further with a real model. Goal was: "${goal}"`,
      };
    },
  };
}

interface ScriptedModelStep {
  message?: string;
  toolCalls?: Array<{ toolName: string; arguments: unknown }>;
}

async function createScriptedModel(
  ref: string,
  env: Record<string, string | undefined>,
): Promise<
  { ok: true; adapter: ModelAdapter } | { ok: false; message: string }
> {
  const script = await loadScriptedModelSteps(env);
  if (!script.ok) return script;
  let turn = 0;
  return {
    ok: true,
    adapter: {
      id: SCRIPTED_PROVIDER,
      async complete() {
        const step = script.steps[turn] ?? {
          message: "scripted model completed.",
        };
        turn += 1;
        const startedAt = new Date().toISOString();
        return {
          ...(step.message !== undefined ? { message: step.message } : {}),
          ...(step.toolCalls !== undefined
            ? { toolCalls: step.toolCalls }
            : {}),
          trace: {
            attempt: 1,
            maxAttempts: 1,
            retryCount: 0,
            adapterId: ref,
            streaming: false,
            durationMs: 0,
            ttltMs: 0,
            requestStartedAt: startedAt,
            requestCompletedAt: startedAt,
            ...(step.message !== undefined
              ? { messageChars: step.message.length }
              : {}),
            toolCallCount: step.toolCalls?.length ?? 0,
          },
        };
      },
    },
  };
}

async function loadScriptedModelSteps(
  env: Record<string, string | undefined>,
): Promise<
  { ok: true; steps: ScriptedModelStep[] } | { ok: false; message: string }
> {
  const json = env[SCRIPTED_MODEL_JSON_ENV];
  const file = env[SCRIPTED_MODEL_FILE_ENV];
  if (json && file) {
    return {
      ok: false,
      message: `${SCRIPTED_MODEL_JSON_ENV} and ${SCRIPTED_MODEL_FILE_ENV} are mutually exclusive.`,
    };
  }
  if (!json && !file) {
    return {
      ok: false,
      message: `Model "scripted" requires ${SCRIPTED_MODEL_JSON_ENV} or ${SCRIPTED_MODEL_FILE_ENV}.`,
    };
  }
  const raw = file ? await readFile(file, "utf8") : (json ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      message: `Invalid scripted model JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const steps = normalizeScriptedModelSteps(parsed);
  if (!steps.ok) return steps;
  return steps.steps.length > 0
    ? steps
    : { ok: false, message: "Scripted model requires at least one step." };
}

function normalizeScriptedModelSteps(
  value: unknown,
): { ok: true; steps: ScriptedModelStep[] } | { ok: false; message: string } {
  const steps = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.steps)
      ? value.steps
      : undefined;
  if (!steps) {
    return {
      ok: false,
      message:
        "Scripted model JSON must be an array of steps or an object with a steps array.",
    };
  }
  const normalized: ScriptedModelStep[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step)) {
      return {
        ok: false,
        message: `Scripted model step ${index + 1} must be an object.`,
      };
    }
    const message = typeof step.message === "string" ? step.message : undefined;
    const toolCalls = step.toolCalls;
    if (step.message !== undefined && message === undefined) {
      return {
        ok: false,
        message: `Scripted model step ${index + 1} message must be a string.`,
      };
    }
    if (toolCalls !== undefined && !isScriptedToolCalls(toolCalls)) {
      return {
        ok: false,
        message: `Scripted model step ${index + 1} toolCalls must be an array of { toolName, arguments } objects.`,
      };
    }
    if (message === undefined && toolCalls === undefined) {
      return {
        ok: false,
        message: `Scripted model step ${index + 1} must include message or toolCalls.`,
      };
    }
    normalized.push({
      ...(message !== undefined ? { message } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    });
  }
  return { ok: true, steps: normalized };
}

function isScriptedToolCalls(
  value: unknown,
): value is Array<{ toolName: string; arguments: unknown }> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.toolName === "string" &&
        entry.toolName.length > 0 &&
        Object.prototype.hasOwnProperty.call(entry, "arguments"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicResolvedModel(
  modelRef: string,
  modelSource: ConfigSourceRef,
): ResolvedModelConfig {
  return {
    modelRef,
    providerKey: DETERMINISTIC_PROVIDER,
    modelId: DETERMINISTIC_PROVIDER,
    adapterId: DETERMINISTIC_PROVIDER,
    modelSource,
  };
}

function configuredResolvedModel(input: {
  modelRef: string;
  providerKey: string;
  modelId: string;
  modelSource: ConfigSourceRef;
  providerSource?: ConfigSourceRef;
  runtimeSources: ProviderRuntimeSources;
}): ResolvedModelConfig {
  return {
    modelRef: input.modelRef,
    providerKey: input.providerKey,
    modelId: input.modelId,
    adapterId: `${input.providerKey}:${input.modelId}`,
    modelSource: input.modelSource,
    ...(input.providerSource ? { providerSource: input.providerSource } : {}),
    authSource: input.runtimeSources.apiKey,
    ...(input.runtimeSources.baseURL
      ? { baseURLSource: input.runtimeSources.baseURL }
      : {}),
  };
}

function sourceRef(origin: string | undefined): ConfigSourceRef | undefined {
  if (!origin) return undefined;
  const separator = origin.indexOf(":");
  if (separator < 0) return { layer: "unknown", path: origin };
  const layer = origin.slice(0, separator);
  const path = origin.slice(separator + 1);
  if (layer === "user" || layer === "project" || layer === "env") {
    return { layer, path };
  }
  return { layer: "unknown", path: origin };
}
