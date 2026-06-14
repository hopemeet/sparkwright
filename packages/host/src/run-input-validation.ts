import { stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  resolveModelSelection,
  type SharedConfig,
} from "./config.js";

const RESERVED_MODEL_REFS = new Set([DETERMINISTIC_PROVIDER, "scripted"]);

export interface RunInputValidationInput {
  workspaceRoot: string;
  targetPath?: string;
  requireTargetExists?: boolean;
  approveAll?: boolean;
  approveShellSafe?: boolean;
  shouldWrite?: boolean;
  modelName?: string;
  validateModel?: boolean;
  env?: Record<string, string | undefined>;
}

export interface RunInputValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateRunInput(
  input: RunInputValidationInput,
): Promise<RunInputValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.approveAll && !input.shouldWrite) {
    warnings.push(
      "--yes does not enable workspace writes without --write; it can still approve other risky actions.",
    );
  }

  const workspaceOk = await validateWorkspace(input.workspaceRoot, errors);
  if (workspaceOk && input.targetPath) {
    await validateTargetPath(input, errors);
  }

  // Surface non-fatal config validation errors. loadHostConfig drops malformed
  // fields and applies the rest, so without this the run path would silently
  // ignore a typo'd field. We report them as warnings, not errors, to preserve
  // the best-effort load behavior.
  const loaded = await loadHostConfig(input.workspaceRoot, input.env);
  for (const error of loaded.errors) {
    warnings.push(`config ${error.file} (${error.field}): ${error.message}`);
  }

  if (input.validateModel && input.modelName) {
    validateModel(input.modelName, loaded.config, errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

async function validateWorkspace(
  workspaceRoot: string,
  errors: string[],
): Promise<boolean> {
  try {
    const workspace = await stat(workspaceRoot);
    if (!workspace.isDirectory()) {
      errors.push(`Workspace is not a directory: ${workspaceRoot}`);
      return false;
    }
    return true;
  } catch (_error) {
    errors.push(
      `Workspace does not exist or is not accessible: ${workspaceRoot}`,
    );
    return false;
  }
}

async function validateTargetPath(
  input: RunInputValidationInput,
  errors: string[],
): Promise<void> {
  const targetPath = input.targetPath ?? "";
  if (!targetPath.trim()) {
    errors.push("Target path must not be empty.");
    return;
  }
  if (isAbsolute(targetPath)) {
    errors.push(`Target must be a workspace-relative path: ${targetPath}`);
    return;
  }

  const workspaceRoot = resolve(input.workspaceRoot);
  const resolvedTarget = resolve(workspaceRoot, targetPath);
  if (
    resolvedTarget !== workspaceRoot &&
    !resolvedTarget.startsWith(`${workspaceRoot}${sep}`)
  ) {
    errors.push(`Target must stay inside the workspace: ${targetPath}`);
    return;
  }

  if (!input.requireTargetExists) return;

  try {
    const target = await stat(resolvedTarget);
    if (!target.isFile()) {
      errors.push(`Target is not a file: ${targetPath}`);
    }
  } catch {
    errors.push(`Target does not exist: ${targetPath}`);
  }
}

function validateModel(
  modelName: string,
  config: SharedConfig,
  errors: string[],
): void {
  if (RESERVED_MODEL_REFS.has(modelName)) return;

  const selection = resolveModelSelection(config, modelName);
  if (selection.kind === "error") errors.push(selection.message);
}
