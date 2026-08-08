import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  snapshotAssetPackage,
  type SnapshotAssetPackageResult,
} from "@sparkwright/skills";
import type { CapabilityMutationEvent } from "@sparkwright/core";

export type CapabilityPackageMutationAction =
  | "ensure_directory"
  | "remove_tree"
  | "write_text"
  | "snapshot_skill_package"
  | "replace_skill_package";

export interface CapabilityPackageMutationResult {
  action: CapabilityPackageMutationAction;
  path: string;
  reason?: string;
  sourcePath?: string;
  files?: SnapshotAssetPackageResult["files"];
}

export interface CapabilityPackageMutationReporter {
  reportCapabilityMutationCompleted?(payload: CapabilityMutationEvent): void;
}

export interface CapabilityPackageMutationWriter {
  ensureDirectory(
    path: string,
    options?: { reason?: string; allowWorkspaceRoot?: boolean },
  ): Promise<CapabilityPackageMutationResult>;
  removeTree(
    path: string,
    options?: { reason?: string },
  ): Promise<CapabilityPackageMutationResult>;
  writeText(
    path: string,
    content: string,
    options?: { reason?: string },
  ): Promise<CapabilityPackageMutationResult>;
  writeJson(
    path: string,
    value: unknown,
    options?: { reason?: string },
  ): Promise<CapabilityPackageMutationResult>;
  snapshotSkillPackage(
    sourceDir: string,
    targetDir: string,
    options?: { reason?: string },
  ): Promise<CapabilityPackageMutationResult>;
  replaceWithSkillPackage(
    sourceDir: string,
    targetDir: string,
    options?: { reason?: string },
  ): Promise<CapabilityPackageMutationResult>;
}

export function createFileCapabilityPackageWriter(
  workspaceRoot: string,
  reporter?: CapabilityPackageMutationReporter,
): CapabilityPackageMutationWriter {
  return new FileCapabilityPackageMutationWriter(workspaceRoot, reporter);
}

class FileCapabilityPackageMutationWriter implements CapabilityPackageMutationWriter {
  private readonly workspaceRoot: string;
  private readonly reporter: CapabilityPackageMutationReporter | undefined;

  constructor(
    workspaceRoot: string,
    reporter: CapabilityPackageMutationReporter | undefined,
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.reporter = reporter;
  }

  async ensureDirectory(
    path: string,
    options: { reason?: string; allowWorkspaceRoot?: boolean } = {},
  ): Promise<CapabilityPackageMutationResult> {
    const target = this.resolveTarget(path, {
      allowWorkspaceRoot: options.allowWorkspaceRoot,
    });
    await mkdir(target, { recursive: true });
    return this.report({
      action: "ensure_directory",
      path: target,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  async removeTree(
    path: string,
    options: { reason?: string } = {},
  ): Promise<CapabilityPackageMutationResult> {
    const target = this.resolveTarget(path);
    await rm(target, { recursive: true, force: true });
    return this.report({
      action: "remove_tree",
      path: target,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  async writeText(
    path: string,
    content: string,
    options: { reason?: string } = {},
  ): Promise<CapabilityPackageMutationResult> {
    const target = this.resolveTarget(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return this.report({
      action: "write_text",
      path: target,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  async writeJson(
    path: string,
    value: unknown,
    options: { reason?: string } = {},
  ): Promise<CapabilityPackageMutationResult> {
    return this.writeText(path, `${JSON.stringify(value, null, 2)}\n`, options);
  }

  async snapshotSkillPackage(
    sourceDir: string,
    targetDir: string,
    options: { reason?: string } = {},
  ): Promise<CapabilityPackageMutationResult> {
    return this.copySkillPackage(
      sourceDir,
      targetDir,
      "snapshot_skill_package",
      options,
    );
  }

  async replaceWithSkillPackage(
    sourceDir: string,
    targetDir: string,
    options: { reason?: string } = {},
  ): Promise<CapabilityPackageMutationResult> {
    return this.copySkillPackage(
      sourceDir,
      targetDir,
      "replace_skill_package",
      options,
    );
  }

  private async copySkillPackage(
    sourceDir: string,
    targetDir: string,
    action: "snapshot_skill_package" | "replace_skill_package",
    options: { reason?: string },
  ): Promise<CapabilityPackageMutationResult> {
    const target = this.resolveTarget(targetDir);
    const snapshot = await snapshotAssetPackage(
      { rootPath: sourceDir, entryPath: "SKILL.md" },
      target,
    );
    return this.report({
      action,
      path: target,
      sourcePath: snapshot.sourceDir,
      files: snapshot.files,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  private report(
    result: CapabilityPackageMutationResult,
  ): CapabilityPackageMutationResult {
    this.reporter?.reportCapabilityMutationCompleted?.({
      action: result.action,
      path: result.path,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.sourcePath ? { sourcePath: result.sourcePath } : {}),
      ...(result.files
        ? {
            fileCount: result.files.length,
            files: result.files.map((file) => ({
              relativePath: file.relativePath,
              size: file.size,
            })),
          }
        : {}),
    });
    return result;
  }

  private resolveTarget(
    path: string,
    options: { allowWorkspaceRoot?: boolean } = {},
  ): string {
    const target = isAbsolute(path)
      ? resolve(path)
      : resolve(this.workspaceRoot, path);
    const relativePath = relative(this.workspaceRoot, target);
    const inside =
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath));
    if (!inside) {
      throw new Error(
        `Capability package mutation target escapes workspace: ${path}`,
      );
    }
    if (relativePath === "" && !options.allowWorkspaceRoot) {
      throw new Error(
        "Capability package mutation target cannot be workspace root.",
      );
    }
    return target.split(sep).join("/");
  }
}
