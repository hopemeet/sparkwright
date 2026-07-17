import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import type { RunBudget } from "@sparkwright/core";
import type {
  WorkflowCommandNodeDefinition,
  WorkflowDelegateNodeDefinition,
  WorkflowDiffScopeVerifierDefinition,
  WorkflowDefinition,
  WorkflowHumanNodeDefinition,
  WorkflowJoinNodeDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeExecuteKind,
  WorkflowParallelNodeDefinition,
  PinnedWorkflowDefinition,
  WorkflowScriptNodeCapability,
  WorkflowScriptNodeDefinition,
  WorkflowTaskNodeDefinition,
  WorkflowTaskNodeMode,
  WorkflowTodoClearVerifierDefinition,
  WorkflowTransitionDefinition,
  WorkflowVerifierDefinition,
  WorkflowVerifierExpectation,
} from "@sparkwright/agent-runtime";
import {
  computeAssetPackageHash,
  discoverMarkdownFolderAssets,
  loadMarkdownFolderAsset,
  markdownAssetContentHash,
  snapshotAssetPackage,
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
  "human",
  "script",
  "parallel",
  "join",
]);
const WORKFLOW_SCRIPT_CAPABILITIES = new Set<WorkflowScriptNodeCapability>([
  "read",
  "write",
  "shell",
  "network",
  "mcp",
  "agent",
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

export interface PinnedWorkflowAsset {
  asset: Omit<WorkflowAssetDetail, "definition"> & {
    packageHash: string;
    packageHashPolicyVersion: 2;
    definition: PinnedWorkflowDefinition;
  };
  packageHash: string;
  packageHashPolicyVersion: 2;
  packageSnapshotRef: string;
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

export async function pinWorkflowAssetPackage(input: {
  asset: WorkflowAssetDetail;
  snapshotRoot: string;
  /** Internal test/coordination seam between snapshot copy and source recheck. */
  afterSnapshot?: () => Promise<void> | void;
}): Promise<PinnedWorkflowAsset> {
  const spec = {
    rootPath: input.asset.definition.sourceDir!,
    entryPath: WORKFLOW_FILE_NAME,
  };
  const before = await computeAssetPackageHash(spec);
  await mkdir(input.snapshotRoot, { recursive: true });
  const packageSnapshotRef = join(
    input.snapshotRoot,
    before.packageHash.slice("sha256:".length),
  );
  const temporarySnapshotRef = await mkdtemp(
    join(input.snapshotRoot, ".pending-"),
  );
  try {
    const snapshot = await snapshotAssetPackage(spec, temporarySnapshotRef);
    await input.afterSnapshot?.();
    const after = await computeAssetPackageHash(spec);
    if (
      snapshot.packageHash !== before.packageHash ||
      after.packageHash !== before.packageHash
    ) {
      throw new Error(
        `Workflow package changed while snapshotting: ${input.asset.assetName}`,
      );
    }
    try {
      await rename(temporarySnapshotRef, packageSnapshotRef);
    } catch (error) {
      try {
        await verifyWorkflowPackageSnapshot({
          packageSnapshotRef,
          packageHash: before.packageHash,
        });
      } catch {
        throw error;
      }
    }
  } finally {
    await rm(temporarySnapshotRef, { recursive: true, force: true });
  }
  const snapshotAsset = await loadWorkflowAssetFromDir({
    dir: packageSnapshotRef,
    layer: input.asset.layer,
  });
  const asset: WorkflowAssetDetail = {
    ...snapshotAsset,
    assetName: input.asset.assetName,
    definition: {
      ...snapshotAsset.definition,
      assetName: input.asset.assetName,
    },
  };
  const { contentHash: _contentHash, ...executableDefinition } =
    asset.definition;
  return {
    asset: {
      ...asset,
      packageHash: before.packageHash,
      packageHashPolicyVersion: 2,
      definition: {
        ...executableDefinition,
        sourceDir: packageSnapshotRef,
        layer: asset.layer,
        packageHash: before.packageHash,
        packageHashPolicyVersion: 2,
        packageSnapshotRef,
      },
    },
    packageHash: before.packageHash,
    packageHashPolicyVersion: 2,
    packageSnapshotRef,
  };
}

export async function verifyWorkflowPackageSnapshot(input: {
  packageSnapshotRef: string;
  packageHash: string;
}): Promise<void> {
  const snapshot = await computeAssetPackageHash({
    rootPath: input.packageSnapshotRef,
    entryPath: WORKFLOW_FILE_NAME,
  });
  if (snapshot.packageHash !== input.packageHash) {
    throw new Error(
      "Workflow executable package snapshot hash does not match its record.",
    );
  }
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
    sourcePath: markdown.sourcePath,
    sourceDir: markdown.dir,
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
    model: optionalString(raw.model),
    runBudget: parseWorkflowRunBudget(raw.runBudget ?? raw.run_budget, id),
    body: sectionBody.get(id) ?? optionalString(raw.body) ?? fallbackBody ?? "",
    tools: optionalStringArray(raw.tools),
    command: parseWorkflowCommandNode(raw, id),
    delegate: parseWorkflowDelegateNode(raw, id),
    task: parseWorkflowTaskNode(raw, id),
    human: parseWorkflowHumanNode(raw, id),
    script: parseWorkflowScriptNode(raw, id),
    parallel: parseWorkflowParallelNode(raw, id),
    join: parseWorkflowJoinNode(raw, id),
    verify: parseWorkflowVerifiers(raw.verify, id),
    onPass: parseWorkflowTransition(raw.onPass ?? raw.on_pass, id, "onPass"),
    onFail: parseWorkflowTransition(raw.onFail ?? raw.on_fail, id, "onFail"),
    metadata: optionalRecord(raw.metadata),
  });
}

function workflowNodeFromFields(input: {
  id: string;
  title?: string;
  execute?: string;
  model?: string;
  runBudget?: RunBudget;
  body: string;
  tools?: string[];
  command?: WorkflowCommandNodeDefinition;
  delegate?: WorkflowDelegateNodeDefinition;
  task?: WorkflowTaskNodeDefinition;
  human?: WorkflowHumanNodeDefinition;
  script?: WorkflowScriptNodeDefinition;
  parallel?: WorkflowParallelNodeDefinition;
  join?: WorkflowJoinNodeDefinition;
  verify?: WorkflowVerifierDefinition[];
  onPass?: WorkflowTransitionDefinition;
  onFail?: WorkflowTransitionDefinition;
  metadata?: Record<string, unknown>;
}): WorkflowNodeDefinition {
  if (!WORKFLOW_NODE_ID_PATTERN.test(input.id)) {
    throw new Error(
      `Workflow node id must use letters, numbers, '.', '_', ':', or '-' (max 64 chars): ${input.id}`,
    );
  }
  if (input.execute === "ask_user") {
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
      `Workflow node ${input.id} execute must be one of: model, command, delegate, task, human, script, parallel, join.`,
    );
  }
  return {
    id: input.id,
    ...(input.title ? { title: input.title } : {}),
    execute,
    ...(input.model ? { model: input.model } : {}),
    ...(input.runBudget ? { runBudget: input.runBudget } : {}),
    body: input.body.trim(),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.delegate ? { delegate: input.delegate } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.human ? { human: input.human } : {}),
    ...(input.script ? { script: input.script } : {}),
    ...(input.parallel ? { parallel: input.parallel } : {}),
    ...(input.join ? { join: input.join } : {}),
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.onPass ? { onPass: input.onPass } : {}),
    ...(input.onFail ? { onFail: input.onFail } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function parseWorkflowCommandNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowCommandNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.command) ? raw.command : raw;
  const command = isRecord(raw.command)
    ? optionalString(raw.command.command)
    : optionalString(raw.command);
  if (execute !== "command" && !command) return undefined;
  if (!command) {
    throw new Error(`Workflow command node ${nodeId} requires command.`);
  }
  const args = optionalStringArray(source.args);
  const cwd = optionalString(source.cwd);
  const timeoutMs = nonNegativeInteger(source.timeoutMs);
  const maxOutputBytes = nonNegativeInteger(source.maxOutputBytes);
  const expect = parseWorkflowExpectation(
    source.expect,
    `Workflow command node ${nodeId} expect`,
  );
  return {
    command,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(expect ? { expect } : {}),
    ...(workflowCommandAuthorized(source) ? { authorized: true } : {}),
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowDelegateNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowDelegateNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.delegate) ? raw.delegate : raw;
  const agentId = optionalString(source.agentId);
  const goal = optionalString(source.goal);
  if (execute !== "delegate" && !agentId && !goal) {
    return undefined;
  }
  if (!agentId) {
    throw new Error(`Workflow delegate node ${nodeId} requires agentId.`);
  }
  if (!goal) {
    throw new Error(`Workflow delegate node ${nodeId} requires goal.`);
  }
  return {
    agentId,
    goal,
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowTaskNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowTaskNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.task) ? raw.task : raw;
  const kind = optionalString(source.kind);
  if (execute !== "task" && !kind) return undefined;
  if (!kind) {
    throw new Error(`Workflow task node ${nodeId} requires kind.`);
  }
  const mode = parseWorkflowTaskMode(source.mode, nodeId);
  const awaited =
    typeof source.awaited === "boolean" ? source.awaited : undefined;
  return {
    kind,
    ...(optionalString(source.title)
      ? { title: optionalString(source.title) }
      : {}),
    ...(mode ? { mode } : {}),
    ...(awaited !== undefined ? { awaited } : {}),
    ...(source.payload !== undefined ? { payload: source.payload } : {}),
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowTaskMode(
  raw: unknown,
  nodeId: string,
): WorkflowTaskNodeMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === "foreground" || raw === "awaited" || raw === "background") {
    return raw;
  }
  throw new Error(
    `Workflow task node ${nodeId} mode must be foreground, awaited, or background.`,
  );
}

function parseWorkflowHumanNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowHumanNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.human) ? raw.human : raw;
  if (execute !== "human" && !isRecord(raw.human)) return undefined;
  const waitSource = isRecord(source.wait) ? source.wait : source;
  const kind = optionalString(waitSource.kind) ?? "input";
  if (kind !== "input" && kind !== "task" && kind !== "approval") {
    throw new Error(
      `Workflow human node ${nodeId} wait.kind must be input, task, or approval.`,
    );
  }
  const reason =
    optionalString(waitSource.reason) ??
    optionalString(source.reason) ??
    optionalString(source.prompt);
  return {
    ...(optionalString(source.prompt)
      ? { prompt: optionalString(source.prompt) }
      : {}),
    wait: {
      kind,
      ...(reason ? { reason } : {}),
      ...(optionalString(waitSource.taskId)
        ? { taskId: optionalString(waitSource.taskId) }
        : {}),
      ...(optionalString(waitSource.approvalId)
        ? { approvalId: optionalString(waitSource.approvalId) }
        : {}),
      ...(optionalRecord(waitSource.metadata)
        ? { metadata: optionalRecord(waitSource.metadata) }
        : {}),
    },
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowScriptNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowScriptNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.script) ? raw.script : raw;
  const path = isRecord(raw.script)
    ? optionalString(raw.script.path)
    : optionalString(raw.script);
  if (execute !== "script" && !path) return undefined;
  if (!path) {
    throw new Error(`Workflow script node ${nodeId} requires script.path.`);
  }
  if (!isSafeRelativeWorkflowScriptPath(path)) {
    throw new Error(
      `Workflow script node ${nodeId} script.path must be a relative path inside the workflow asset.`,
    );
  }
  const args = optionalStringArray(source.args);
  const cwd = optionalString(source.cwd);
  if (cwd && !isSafeRelativeWorkflowScriptCwd(cwd)) {
    throw new Error(
      `Workflow script node ${nodeId} cwd must be relative to the workflow asset.`,
    );
  }
  const timeoutMs = nonNegativeInteger(source.timeoutMs);
  const maxOutputBytes = nonNegativeInteger(source.maxOutputBytes);
  const env = optionalStringRecord(source.env);
  const stdin = optionalString(source.stdin);
  const capabilities = parseWorkflowScriptCapabilities(
    source.capabilities,
    nodeId,
  );
  return {
    path,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(stdin ? { stdin } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowScriptCapabilities(
  raw: unknown,
  nodeId: string,
): WorkflowScriptNodeCapability[] | undefined {
  const values = optionalStringArray(raw);
  if (!values) return undefined;
  const invalid = values.find(
    (value) =>
      !WORKFLOW_SCRIPT_CAPABILITIES.has(value as WorkflowScriptNodeCapability),
  );
  if (invalid) {
    throw new Error(
      `Workflow script node ${nodeId} capabilities must use: read, write, shell, network, mcp, agent, task.`,
    );
  }
  return [...new Set(values as WorkflowScriptNodeCapability[])];
}

function parseWorkflowParallelNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowParallelNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.parallel) ? raw.parallel : raw;
  const branches = optionalStringArray(source.branches);
  if (execute !== "parallel" && !branches) return undefined;
  if (!branches || branches.length === 0) {
    throw new Error(`Workflow parallel node ${nodeId} requires branches.`);
  }
  const uniqueBranches = [...new Set(branches)];
  if (uniqueBranches.length !== branches.length) {
    throw new Error(
      `Workflow parallel node ${nodeId} branches must not contain duplicates.`,
    );
  }
  const maxConcurrency = positiveInteger(
    source.maxConcurrency ?? source.max_concurrency,
  );
  if (
    (source.maxConcurrency !== undefined ||
      source.max_concurrency !== undefined) &&
    maxConcurrency === undefined
  ) {
    throw new Error(
      `Workflow parallel node ${nodeId} maxConcurrency must be a positive integer.`,
    );
  }
  return {
    branches: uniqueBranches,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function parseWorkflowJoinNode(
  raw: Record<string, unknown>,
  nodeId: string,
): WorkflowJoinNodeDefinition | undefined {
  const execute = optionalString(raw.execute) ?? optionalString(raw.type);
  const source = isRecord(raw.join) ? raw.join : raw;
  const waitFor =
    optionalStringArray(source.waitFor ?? source.wait_for) ??
    optionalStringArray(source.branches);
  if (execute !== "join" && !waitFor) return undefined;
  if (!waitFor || waitFor.length === 0) {
    throw new Error(`Workflow join node ${nodeId} requires waitFor.`);
  }
  const uniqueWaitFor = [...new Set(waitFor)];
  if (uniqueWaitFor.length !== waitFor.length) {
    throw new Error(
      `Workflow join node ${nodeId} waitFor must not contain duplicates.`,
    );
  }
  return {
    waitFor: uniqueWaitFor,
    ...(optionalRecord(source.metadata)
      ? { metadata: optionalRecord(source.metadata) }
      : {}),
  };
}

function isSafeRelativeWorkflowScriptPath(path: string): boolean {
  if (isAbsolute(path) || path.includes("\0") || path.includes("\\")) {
    return false;
  }
  const normalized = normalize(path);
  if (normalized === "." || normalized === "..") return false;
  if (normalized.startsWith(`..${sep}`)) return false;
  return true;
}

function isSafeRelativeWorkflowScriptCwd(path: string): boolean {
  if (path === ".") return true;
  return isSafeRelativeWorkflowScriptPath(path);
}

function parseWorkflowVerifiers(
  raw: unknown,
  nodeId: string,
): WorkflowVerifierDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Workflow node ${nodeId} verify must be an array.`);
  }
  const verifiers = raw.map((entry, index) =>
    parseWorkflowVerifier(entry, nodeId, index),
  );
  return verifiers.length > 0 ? verifiers : undefined;
}

function parseWorkflowVerifier(
  raw: unknown,
  nodeId: string,
  index: number,
): WorkflowVerifierDefinition {
  if (!isRecord(raw)) {
    throw new Error(
      `Workflow node ${nodeId} verifier ${index + 1} must be an object.`,
    );
  }
  const kind = optionalString(raw.kind) ?? "command";
  if (kind === "diff_scope") {
    return parseWorkflowDiffScopeVerifier(raw, nodeId, index);
  }
  if (kind === "todo_clear") {
    return parseWorkflowTodoClearVerifier(raw, nodeId, index);
  }
  if (kind !== "command") {
    throw new Error(
      `Workflow node ${nodeId} verifier ${index + 1} kind must be command, diff_scope, or todo_clear for P6b.`,
    );
  }
  const command = optionalString(raw.command);
  if (!command) {
    throw new Error(
      `Workflow node ${nodeId} verifier ${index + 1} requires command and args; run string shorthand is not supported in P1.`,
    );
  }
  const args = optionalStringArray(raw.args);
  const cwd = optionalString(raw.cwd);
  const timeoutMs = nonNegativeInteger(raw.timeoutMs);
  const maxOutputBytes = nonNegativeInteger(raw.maxOutputBytes);
  const expect = parseWorkflowExpectation(
    raw.expect,
    `Workflow node ${nodeId} verifier ${index + 1} expect`,
  );
  return {
    id:
      optionalString(raw.id) ??
      optionalString(raw.name) ??
      `${nodeId}:command:${index + 1}`,
    kind: "command",
    command,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(expect ? { expect } : {}),
    ...(workflowCommandAuthorized(raw) ? { authorized: true } : {}),
    ...(optionalRecord(raw.metadata)
      ? { metadata: optionalRecord(raw.metadata) }
      : {}),
  };
}

function parseWorkflowDiffScopeVerifier(
  raw: Record<string, unknown>,
  nodeId: string,
  index: number,
): WorkflowDiffScopeVerifierDefinition {
  return {
    id:
      optionalString(raw.id) ??
      optionalString(raw.name) ??
      `${nodeId}:diff_scope:${index + 1}`,
    kind: "diff_scope",
    ...(optionalStringArray(raw.include)
      ? { include: optionalStringArray(raw.include) }
      : {}),
    ...(optionalStringArray(raw.exclude)
      ? { exclude: optionalStringArray(raw.exclude) }
      : {}),
    ...(optionalRecord(raw.metadata)
      ? { metadata: optionalRecord(raw.metadata) }
      : {}),
  };
}

function parseWorkflowTodoClearVerifier(
  raw: Record<string, unknown>,
  nodeId: string,
  index: number,
): WorkflowTodoClearVerifierDefinition {
  return {
    id:
      optionalString(raw.id) ??
      optionalString(raw.name) ??
      `${nodeId}:todo_clear:${index + 1}`,
    kind: "todo_clear",
    ...(optionalRecord(raw.metadata)
      ? { metadata: optionalRecord(raw.metadata) }
      : {}),
  };
}

function parseWorkflowExpectation(
  raw: unknown,
  field: string,
): WorkflowVerifierExpectation | undefined {
  if (raw === undefined) return undefined;
  if (raw === "zero" || raw === "nonzero") return raw;
  throw new Error(`${field} must be zero or nonzero.`);
}

function parseWorkflowRunBudget(
  raw: unknown,
  nodeId: string,
): RunBudget | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Workflow node ${nodeId} runBudget must be an object.`);
  }
  const budget: RunBudget = {};
  for (const key of [
    "maxDurationMs",
    "maxModelCalls",
    "maxToolCalls",
    "maxTokens",
  ] as const) {
    if (raw[key] === undefined) continue;
    const value = positiveInteger(raw[key]);
    if (value === undefined) {
      throw new Error(
        `Workflow node ${nodeId} runBudget.${key} must be a positive integer.`,
      );
    }
    budget[key] = value;
  }
  if (raw.maxCostUsd !== undefined) {
    if (
      typeof raw.maxCostUsd !== "number" ||
      !Number.isFinite(raw.maxCostUsd) ||
      raw.maxCostUsd <= 0
    ) {
      throw new Error(
        `Workflow node ${nodeId} runBudget.maxCostUsd must be a positive number.`,
      );
    }
    budget.maxCostUsd = raw.maxCostUsd;
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function workflowCommandAuthorized(raw: Record<string, unknown>): boolean {
  return raw.authorized === true || raw.authorization === "trusted";
}

function parseWorkflowTransition(
  raw: unknown,
  nodeId: string,
  field: "onPass" | "onFail",
): WorkflowTransitionDefinition | undefined {
  if (raw === undefined) return undefined;
  const target = optionalString(raw);
  if (target) return target;
  if (!isRecord(raw)) {
    throw new Error(
      `Workflow node ${nodeId} ${field} must be a target or object.`,
    );
  }
  const goto = optionalString(raw.goto);
  if (goto) return { goto };
  if (raw.fail !== undefined) {
    if (raw.fail === true) return { fail: true };
    const reason = optionalString(raw.fail);
    if (reason) return { fail: reason };
    throw new Error(
      `Workflow node ${nodeId} ${field}.fail must be true or a string.`,
    );
  }
  if (raw.retry !== undefined) {
    const retry = nonNegativeInteger(raw.retry);
    if (retry === undefined) {
      throw new Error(
        `Workflow node ${nodeId} ${field}.retry must be a non-negative integer.`,
      );
    }
    const then = parseWorkflowTransition(raw.then, nodeId, field);
    return {
      retry,
      ...(then ? { then } : {}),
    };
  }
  throw new Error(
    `Workflow node ${nodeId} ${field} must use goto, retry, or fail.`,
  );
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

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item) => {
    const parsed = optionalString(item);
    return parsed ? [parsed] : [];
  });
  return items.length > 0 ? items : undefined;
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, entry]) => {
    const parsed = optionalString(entry);
    return parsed ? [[key, parsed] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
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
