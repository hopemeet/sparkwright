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
