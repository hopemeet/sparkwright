import type { RuntimeContext } from "@sparkwright/core";

export interface CapabilityWriteResult {
  path: string;
  diffArtifactId?: string;
  summary?: unknown;
}

export async function writeCapabilityText(
  ctx: RuntimeContext,
  path: string,
  content: string,
  reason: string,
): Promise<CapabilityWriteResult> {
  if (!ctx.workspace) throw new Error("Workspace is not configured.");
  const write = await ctx.workspace.writeText(path, content, { reason });
  if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
  return {
    path: write?.path ?? (await canonicalWorkspacePath(ctx, path)),
    diffArtifactId: write?.diffArtifactId,
    summary: write?.summary,
  };
}

export async function writeCapabilityJson(
  ctx: RuntimeContext,
  path: string,
  data: unknown,
  reason: string,
): Promise<CapabilityWriteResult> {
  return writeCapabilityText(
    ctx,
    path,
    `${JSON.stringify(data, null, 2)}\n`,
    reason,
  );
}

export async function removeCapabilityFile(
  ctx: RuntimeContext,
  path: string,
  reason: string,
): Promise<CapabilityWriteResult> {
  if (!ctx.workspace?.removeFile) {
    throw new Error("Workspace does not support managed file removal.");
  }
  const write = await ctx.workspace.removeFile(path, { reason });
  if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
  return {
    path: write?.path ?? (await canonicalWorkspacePath(ctx, path)),
    diffArtifactId: write?.diffArtifactId,
    summary: write?.summary,
  };
}

export async function canonicalWorkspacePath(
  ctx: RuntimeContext,
  path: string,
): Promise<string> {
  if (!ctx.workspace) throw new Error("Workspace is not configured.");
  return typeof ctx.workspace.canonicalPath === "function"
    ? await ctx.workspace.canonicalPath(path)
    : path;
}

export async function readWorkspaceTextIfExists(
  ctx: RuntimeContext,
  path: string,
): Promise<string | undefined> {
  if (!ctx.workspace) throw new Error("Workspace is not configured.");
  return ctx.workspace.readText(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}
