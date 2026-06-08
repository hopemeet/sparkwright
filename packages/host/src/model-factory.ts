import type { ModelAdapter } from "@sparkwright/core";
import {
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  resolveModelSelection,
} from "./config.js";
import { buildConfiguredAdapter } from "./model-builder.js";

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
  { ok: true; adapter: ModelAdapter } | { ok: false; message: string }
> {
  const env = input.env ?? process.env;
  const loaded = await loadHostConfig(input.workspaceRoot, env);
  const ref = input.modelRef ?? loaded.config.model ?? DETERMINISTIC_PROVIDER;
  const targetPath = input.targetPath ?? "README.md";

  if (ref === DETERMINISTIC_PROVIDER) {
    return { ok: true, adapter: createDemoModel(input.goal, targetPath) };
  }

  const selection = resolveModelSelection(loaded.config, ref);
  if (selection.kind === "deterministic") {
    return { ok: true, adapter: createDemoModel(input.goal, targetPath) };
  }
  if (selection.kind === "error") {
    return { ok: false, message: selection.message };
  }
  return buildConfiguredAdapter({ selection, env });
}

/** Two-turn deterministic model used for protocol smoke tests and TUI demos. */
function createDemoModel(goal: string, targetPath: string): ModelAdapter {
  let turn = 0;
  return {
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
