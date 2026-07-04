import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeExecuteKind,
} from "@sparkwright/agent-runtime";
import {
  discoverMarkdownFolderAssets,
  loadMarkdownFolderAsset,
  markdownAssetContentHash,
  splitMarkdownFrontmatter,
  type MarkdownFolderAsset,
} from "@sparkwright/skills";
import { parse as parseYaml } from "yaml";
import {
  resolveCapabilityDirs,
  type CapabilityLayer,
  type ResolvedCapabilityDir,
} from "./layers.js";

export const WORKFLOW_FILE_NAME = "workflow.md";
const WORKFLOW_CONFIG_FILES = ["config.yaml", "config.yml"] as const;
const WORKFLOW_NODE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const WORKFLOW_NODE_EXECUTE_KINDS = new Set<WorkflowNodeExecuteKind>([
  "model",
  "command",
  "delegate",
  "task",
]);

export interface WorkflowAssetSummary {
  assetName: string;
  sourcePath: string;
  layer: CapabilityLayer;
  contentHash: string;
  version?: string;
  description?: string;
  nodeCount: number;
  configPath?: string;
}

export interface WorkflowAssetDetail extends WorkflowAssetSummary {
  definition: WorkflowDefinition;
}

export interface WorkflowAssetError {
  sourcePath: string;
  layer: CapabilityLayer;
  message: string;
}

export interface WorkflowAssetShadow {
  assetName: string;
  keptSource: string;
  shadowedSource: string;
}

export interface WorkflowAssetRoot {
  layer: CapabilityLayer;
  path: string;
  exists: boolean;
  readOnly: boolean;
}

export interface WorkflowAssetReport {
  roots: WorkflowAssetRoot[];
  assets: WorkflowAssetDetail[];
  errors: WorkflowAssetError[];
  shadows: WorkflowAssetShadow[];
}

export async function loadLayeredWorkflowAssets(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WorkflowAssetReport> {
  const roots = resolveCapabilityDirs("workflows", {
    cwd: workspaceRoot,
    env,
  });
  const rootSummaries = await Promise.all(roots.map(workflowRootSummary));
  const byName = new Map<string, WorkflowAssetDetail>();
  const errors: WorkflowAssetError[] = [];
  const shadows: WorkflowAssetShadow[] = [];

  for (const root of roots) {
    const discovered = await discoverWorkflowAssetsInDir(root, (error) =>
      errors.push(error),
    );
    for (const asset of discovered) {
      const existing = byName.get(asset.assetName);
      if (existing) {
        shadows.push({
          assetName: asset.assetName,
          keptSource: asset.sourcePath,
          shadowedSource: existing.sourcePath,
        });
      }
      byName.set(asset.assetName, asset);
    }
  }

  return {
    roots: rootSummaries,
    assets: [...byName.values()].sort((left, right) =>
      left.assetName.localeCompare(right.assetName),
    ),
    errors,
    shadows,
  };
}

export async function loadWorkflowAssetFromDir(input: {
  dir: string;
  layer?: CapabilityLayer;
}): Promise<WorkflowAssetDetail> {
  const markdown = await loadMarkdownFolderAsset({
    dir: input.dir,
    fileName: WORKFLOW_FILE_NAME,
    parseFrontmatter: parseWorkflowFrontmatter,
  });
  return workflowDetailFromMarkdown(markdown, input.layer ?? "project");
}

export function parseWorkflowMarkdownAsset(input: {
  assetName: string;
  sourcePath: string;
  dir: string;
  raw: string;
  config?: Record<string, unknown>;
  configPath?: string;
  layer?: CapabilityLayer;
}): WorkflowAssetDetail {
  const split = splitMarkdownFrontmatter(input.raw, {
    source: input.sourcePath,
    parseFrontmatter: parseWorkflowFrontmatter,
  });
  return buildWorkflowDetail(
    {
      assetName: input.assetName,
      dir: input.dir,
      sourcePath: input.sourcePath,
      fileName: basename(input.sourcePath),
      frontmatter: split.frontmatter,
      body: split.body,
      contentHash: markdownAssetContentHash(input.raw),
      ...(frontmatterVersion(split.frontmatter)
        ? { version: frontmatterVersion(split.frontmatter) }
        : {}),
    },
    input.layer ?? "project",
    input.config,
    input.configPath,
  );
}

async function discoverWorkflowAssetsInDir(
  root: ResolvedCapabilityDir,
  onError: (error: WorkflowAssetError) => void,
): Promise<WorkflowAssetDetail[]> {
  const assets = await discoverMarkdownFolderAssets({
    root: root.dir,
    fileName: WORKFLOW_FILE_NAME,
    parseFrontmatter: parseWorkflowFrontmatter,
    onError: (sourcePath, error) =>
      onError({
        sourcePath,
        layer: root.layer,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  const details: WorkflowAssetDetail[] = [];
  for (const asset of assets) {
    try {
      details.push(await workflowDetailFromMarkdown(asset, root.layer));
    } catch (error) {
      onError({
        sourcePath: asset.sourcePath,
        layer: root.layer,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return details;
}

async function workflowDetailFromMarkdown(
  markdown: MarkdownFolderAsset,
  layer: CapabilityLayer,
  config?: Record<string, unknown>,
  configPath?: string,
): Promise<WorkflowAssetDetail> {
  if (config !== undefined || configPath !== undefined) {
    return buildWorkflowDetail(markdown, layer, config, configPath);
  }
  const read = await readWorkflowConfig(markdown.dir);
  return buildWorkflowDetail(markdown, layer, read.config, read.configPath);
}

function buildWorkflowDetail(
  markdown: MarkdownFolderAsset,
  layer: CapabilityLayer,
  config: Record<string, unknown> | undefined,
  configPath: string | undefined,
): WorkflowAssetDetail {
  const nodes = parseWorkflowNodes(markdown.frontmatter, markdown.body);
  const description = optionalString(markdown.frontmatter.description);
  const metadata = optionalRecord(markdown.frontmatter.metadata);
  const definition: WorkflowDefinition = {
    assetName: markdown.assetName,
    contentHash: markdown.contentHash,
    ...(markdown.version ? { version: markdown.version } : {}),
    ...(description ? { description } : {}),
    nodes,
    ...(config ? { config } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return {
    assetName: markdown.assetName,
    sourcePath: markdown.sourcePath,
    layer,
    contentHash: markdown.contentHash,
    ...(markdown.version ? { version: markdown.version } : {}),
    ...(description ? { description } : {}),
    nodeCount: nodes.length,
    ...(configPath ? { configPath } : {}),
    definition,
  };
}

function parseWorkflowNodes(
  frontmatter: Record<string, unknown>,
  body: string,
): WorkflowNodeDefinition[] {
  const sectionBody = splitWorkflowNodeSections(body);
  const rawNodes = frontmatter.nodes;
  const nodes =
    rawNodes === undefined
      ? nodesFromSections(sectionBody)
      : normalizeWorkflowNodes(rawNodes, sectionBody, body);
  if (nodes.length === 0) {
    return [{ id: "main", execute: "model", body }];
  }
  return nodes;
}

function normalizeWorkflowNodes(
  rawNodes: unknown,
  sectionBody: Map<string, string>,
  fallbackBody: string,
): WorkflowNodeDefinition[] {
  if (Array.isArray(rawNodes)) {
    return rawNodes.map((raw, index) =>
      workflowNodeFromRaw(
        raw,
        sectionBody,
        index,
        rawNodes.length === 1 ? fallbackBody : undefined,
      ),
    );
  }
  if (rawNodes && typeof rawNodes === "object") {
    const entries = Object.entries(rawNodes as Record<string, unknown>);
    return entries.map(([id, raw], index) =>
      workflowNodeFromRaw(
        { ...(isRecord(raw) ? raw : {}), id },
        sectionBody,
        index,
        entries.length === 1 ? fallbackBody : undefined,
      ),
    );
  }
  throw new Error(
    "Workflow frontmatter field 'nodes' must be an array or object.",
  );
}

function workflowNodeFromRaw(
  raw: unknown,
  sectionBody: Map<string, string>,
  index: number,
  fallbackBody?: string,
): WorkflowNodeDefinition {
  if (typeof raw === "string") {
    return workflowNodeFromFields({
      id: raw,
      body: sectionBody.get(raw) ?? fallbackBody ?? "",
    });
  }
  if (!isRecord(raw)) {
    throw new Error(`Workflow node ${index + 1} must be a string or object.`);
  }
  const id = optionalString(raw.id);
  if (!id) throw new Error(`Workflow node ${index + 1} requires id.`);
  return workflowNodeFromFields({
    id,
    title: optionalString(raw.title) ?? optionalString(raw.name),
    execute: optionalString(raw.execute) ?? optionalString(raw.type),
    body: sectionBody.get(id) ?? optionalString(raw.body) ?? fallbackBody ?? "",
    metadata: optionalRecord(raw.metadata),
  });
}

function workflowNodeFromFields(input: {
  id: string;
  title?: string;
  execute?: string;
  body: string;
  metadata?: Record<string, unknown>;
}): WorkflowNodeDefinition {
  if (!WORKFLOW_NODE_ID_PATTERN.test(input.id)) {
    throw new Error(
      `Workflow node id must use letters, numbers, '.', '_', ':', or '-' (max 64 chars): ${input.id}`,
    );
  }
  if (input.execute === "human" || input.execute === "ask_user") {
    throw new Error(
      `Workflow node ${input.id} uses ${input.execute}, which is reserved for a later phase.`,
    );
  }
  const execute =
    input.execute === undefined
      ? "model"
      : WORKFLOW_NODE_EXECUTE_KINDS.has(
            input.execute as WorkflowNodeExecuteKind,
          )
        ? (input.execute as WorkflowNodeExecuteKind)
        : undefined;
  if (!execute) {
    throw new Error(
      `Workflow node ${input.id} execute must be one of: model, command, delegate, task.`,
    );
  }
  return {
    id: input.id,
    ...(input.title ? { title: input.title } : {}),
    execute,
    body: input.body.trim(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function nodesFromSections(
  sectionBody: Map<string, string>,
): WorkflowNodeDefinition[] {
  return [...sectionBody.entries()].map(([id, body]) =>
    workflowNodeFromFields({ id, body }),
  );
}

function splitWorkflowNodeSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentId: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentId) sections.set(currentId, currentLines.join("\n").trim());
    currentLines = [];
  };

  for (const line of lines) {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (match) {
      const id = parseNodeSectionId(match[1]!);
      if (id) {
        flush();
        currentId = id;
        continue;
      }
    }
    if (currentId) currentLines.push(line);
  }
  flush();
  return sections;
}

function parseNodeSectionId(heading: string): string | undefined {
  const normalized = heading.replace(/^node\s*:\s*/i, "").trim();
  return WORKFLOW_NODE_ID_PATTERN.test(normalized) ? normalized : undefined;
}

async function readWorkflowConfig(
  dir: string,
): Promise<{ config?: Record<string, unknown>; configPath?: string }> {
  for (const file of WORKFLOW_CONFIG_FILES) {
    const configPath = join(dir, file);
    if (!(await isFile(configPath))) continue;
    const parsed = parseYaml(await readFile(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Workflow config must be an object: ${configPath}`);
    }
    return { config: parsed, configPath };
  }
  return {};
}

async function workflowRootSummary(
  root: ResolvedCapabilityDir,
): Promise<WorkflowAssetRoot> {
  return {
    layer: root.layer,
    path: root.dir,
    exists: await isDirectory(root.dir),
    readOnly: root.readOnly,
  };
}

function parseWorkflowFrontmatter(
  raw: string,
  source?: string,
): Record<string, unknown> {
  const parsed = parseYaml(raw) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error(
      `Workflow frontmatter must be an object${source ? ` (${source})` : ""}.`,
    );
  }
  return parsed;
}

function frontmatterVersion(
  frontmatter: Record<string, unknown>,
): string | undefined {
  return optionalString(frontmatter.version);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
