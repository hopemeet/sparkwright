import { join } from "node:path";
import {
  asSessionId,
  loadTraceEventsFile,
  type SparkwrightEvent,
} from "@sparkwright/core";
import type {
  WorkflowCommandNodeDefinition,
  WorkflowCommandVerifierDefinition,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowVerifierDefinition,
} from "@sparkwright/agent-runtime";
import {
  loadLayeredWorkflowAssets,
  type WorkflowAssetDetail,
} from "./workflows.js";
import {
  normalizeWorkflowToolName,
  observeWorkflowTraceEvents,
  type WorkflowTraceObservation,
  type WorkflowTraceObservedCommand,
} from "./workflow-trace-observation.js";

export interface WorkflowShadowOptions {
  workspaceRoot: string;
  sessionRootDir: string;
  workflowName: string;
  sessionId: string;
  env?: Record<string, string | undefined>;
}

export type WorkflowShadowCheckStatus = "matched" | "missing" | "unobserved";

export interface WorkflowShadowCheck {
  id: string;
  kind: "tool" | "write_path" | "verification_command" | "todo_clear";
  status: WorkflowShadowCheckStatus;
  message: string;
  nodeId?: string;
  expected?: unknown;
  observed?: unknown;
}

export interface WorkflowShadowReport {
  ok: boolean;
  workflowName: string;
  sessionId: string;
  tracePath: string;
  eventCount: number;
  asset: {
    sourcePath: string;
    contentHash: string;
    version?: string;
    nodeCount: number;
  };
  goal?: string;
  terminalState?: string;
  observed: {
    tools: string[];
    readPaths: string[];
    writePaths: string[];
    verificationCommands: WorkflowTraceObservedCommand[];
  };
  checks: WorkflowShadowCheck[];
  summary: {
    matched: number;
    missing: number;
    unobserved: number;
    warnings: number;
  };
  warnings: string[];
}

interface WorkflowShadowDeclarations {
  openModelTools: boolean;
  modelTools: Map<string, string[]>;
  nonModelTools: Map<string, string[]>;
  diffScopes: Array<{
    nodeId: string;
    verifierId: string;
    include?: string[];
  }>;
  todoClear: Array<{ nodeId: string; verifierId: string }>;
  commands: Array<{
    nodeId: string;
    verifierId?: string;
    command: string;
  }>;
}

interface ToolProvider {
  label: string;
  nodeId?: string;
}

export async function shadowWorkflowFromSession(
  options: WorkflowShadowOptions,
): Promise<WorkflowShadowReport> {
  const sessionId = asSessionId(options.sessionId);
  const tracePath = join(options.sessionRootDir, sessionId, "trace.jsonl");
  const [assetReport, events] = await Promise.all([
    loadLayeredWorkflowAssets(options.workspaceRoot, options.env),
    loadTraceEventsFile(tracePath),
  ]);
  const asset = assetReport.assets.find(
    (entry) => entry.assetName === options.workflowName,
  );
  if (!asset) {
    throw new Error(`Workflow not found: ${options.workflowName}`);
  }
  return shadowWorkflowFromEvents({
    workflow: asset,
    sessionId,
    tracePath,
    events,
  });
}

export function shadowWorkflowFromEvents(input: {
  workflow: WorkflowAssetDetail;
  sessionId: string;
  tracePath: string;
  events: readonly SparkwrightEvent[];
}): WorkflowShadowReport {
  const observation = observeWorkflowTraceEvents(input.events);
  const declarations = collectDeclarations(input.workflow.definition);
  const checks = buildChecks({
    workflowName: input.workflow.assetName,
    observation,
    declarations,
  });
  const warnings: string[] = [];
  if (observation.terminalState !== "completed") {
    warnings.push(
      observation.terminalState
        ? `source session terminal state is ${observation.terminalState}, not completed`
        : "source session has no completed terminal event",
    );
  }
  if (observation.tools.length === 0) {
    warnings.push("no model-facing tool requests were observed");
  }
  const summary = summarizeChecks(checks, warnings.length);
  return {
    ok: summary.missing === 0 && observation.terminalState === "completed",
    workflowName: input.workflow.assetName,
    sessionId: input.sessionId,
    tracePath: input.tracePath,
    eventCount: observation.eventCount,
    asset: {
      sourcePath: input.workflow.sourcePath,
      contentHash: input.workflow.contentHash,
      ...(input.workflow.version ? { version: input.workflow.version } : {}),
      nodeCount: input.workflow.nodeCount,
    },
    ...(observation.goal ? { goal: observation.goal } : {}),
    ...(observation.terminalState
      ? { terminalState: observation.terminalState }
      : {}),
    observed: {
      tools: observation.tools,
      readPaths: observation.readPaths,
      writePaths: observation.writePaths,
      verificationCommands: observation.verificationCommands,
    },
    checks,
    summary,
    warnings,
  };
}

function buildChecks(input: {
  workflowName: string;
  observation: WorkflowTraceObservation;
  declarations: WorkflowShadowDeclarations;
}): WorkflowShadowCheck[] {
  const checks: WorkflowShadowCheck[] = [];
  const coveredTools = new Set<string>();
  for (const tool of input.observation.tools) {
    const provider = toolProvider(tool, input.declarations);
    if (provider) coveredTools.add(tool);
    checks.push({
      id: `tool:${tool}`,
      kind: "tool",
      status: provider ? "matched" : "missing",
      message: provider
        ? `observed tool ${tool} is covered by ${provider.label}`
        : `observed tool ${tool} is not covered by workflow ${input.workflowName}`,
      ...(provider?.nodeId ? { nodeId: provider.nodeId } : {}),
      observed: tool,
    });
  }

  for (const [tool, nodeIds] of input.declarations.modelTools) {
    if (!coveredTools.has(tool)) {
      checks.push({
        id: `tool:${tool}:unobserved`,
        kind: "tool",
        status: "unobserved",
        message: `workflow declares model tool ${tool}, but the trace did not use it`,
        nodeId: nodeIds[0],
        expected: tool,
      });
    }
  }

  const observedWrites = new Set(input.observation.writePaths);
  for (const path of input.observation.writePaths) {
    const scope = diffScopeProvider(path, input.declarations);
    checks.push({
      id: `write:${path}`,
      kind: "write_path",
      status: scope ? "matched" : "missing",
      message: scope
        ? `observed write ${path} is covered by diff_scope ${scope.verifierId}`
        : `observed write ${path} is not covered by any diff_scope include`,
      ...(scope ? { nodeId: scope.nodeId } : {}),
      observed: path,
    });
  }
  for (const scope of input.declarations.diffScopes) {
    for (const include of scope.include ?? []) {
      if (!observedWrites.has(include)) {
        checks.push({
          id: `write:${scope.verifierId}:${include}:unobserved`,
          kind: "write_path",
          status: "unobserved",
          message: `diff_scope ${scope.verifierId} includes ${include}, but the trace did not write it`,
          nodeId: scope.nodeId,
          expected: include,
        });
      }
    }
  }

  for (const command of input.observation.verificationCommands) {
    const declaration = input.declarations.commands.find(
      (entry) => entry.command === command.command,
    );
    checks.push({
      id: `command:${command.sequence}`,
      kind: "verification_command",
      status: declaration ? "matched" : "missing",
      message: declaration
        ? `observed verification command is declared by workflow`
        : `observed verification command is not declared by workflow`,
      ...(declaration ? { nodeId: declaration.nodeId } : {}),
      expected: command.command,
      observed: command,
    });
  }
  for (const command of input.declarations.commands) {
    const observed = input.observation.verificationCommands.some(
      (entry) => entry.command === command.command,
    );
    if (!observed) {
      checks.push({
        id: `command:${command.verifierId ?? command.nodeId}:unobserved`,
        kind: "verification_command",
        status: "unobserved",
        message: `workflow declares command ${command.command}, but the trace did not observe it as post-write verification`,
        nodeId: command.nodeId,
        expected: command.command,
      });
    }
  }

  if (input.observation.sawTodoWrite) {
    const declaration = input.declarations.todoClear[0];
    checks.push({
      id: "todo_clear",
      kind: "todo_clear",
      status: declaration ? "matched" : "missing",
      message: declaration
        ? "trace used todo_write and workflow declares todo_clear"
        : "trace used todo_write but workflow does not declare todo_clear",
      ...(declaration ? { nodeId: declaration.nodeId } : {}),
      observed: "todo_write",
    });
  } else {
    for (const declaration of input.declarations.todoClear) {
      checks.push({
        id: `todo_clear:${declaration.verifierId}:unobserved`,
        kind: "todo_clear",
        status: "unobserved",
        message: `workflow declares todo_clear ${declaration.verifierId}, but the trace did not use todo_write`,
        nodeId: declaration.nodeId,
        expected: declaration.verifierId,
      });
    }
  }

  return checks;
}

function collectDeclarations(
  definition: WorkflowDefinition,
): WorkflowShadowDeclarations {
  const declarations: WorkflowShadowDeclarations = {
    openModelTools: false,
    modelTools: new Map(),
    nonModelTools: new Map(),
    diffScopes: [],
    todoClear: [],
    commands: [],
  };
  for (const node of definition.nodes) {
    const execute = node.execute ?? "model";
    if (execute === "model") {
      if (!node.tools || node.tools.length === 0) {
        declarations.openModelTools = true;
      } else {
        for (const tool of node.tools) {
          addMapValue(
            declarations.modelTools,
            normalizeWorkflowToolName(tool) ?? tool,
            node.id,
          );
        }
      }
    } else {
      for (const tool of nonModelCoveredTools(node)) {
        addMapValue(declarations.nonModelTools, tool, node.id);
      }
    }
    if (node.command) {
      declarations.commands.push({
        nodeId: node.id,
        command: commandDefinitionString(node.command),
      });
    }
    for (const verifier of node.verify ?? []) {
      collectVerifierDeclaration(node.id, verifier, declarations);
    }
  }
  return declarations;
}

function collectVerifierDeclaration(
  nodeId: string,
  verifier: WorkflowVerifierDefinition,
  declarations: WorkflowShadowDeclarations,
): void {
  if (verifier.kind === "diff_scope") {
    declarations.diffScopes.push({
      nodeId,
      verifierId: verifier.id,
      ...(verifier.include ? { include: verifier.include } : {}),
    });
    return;
  }
  if (verifier.kind === "todo_clear") {
    declarations.todoClear.push({ nodeId, verifierId: verifier.id });
    return;
  }
  declarations.commands.push({
    nodeId,
    verifierId: verifier.id,
    command: verifierCommandString(verifier),
  });
}

function nonModelCoveredTools(node: WorkflowNodeDefinition): string[] {
  switch (node.execute) {
    case "command":
      return ["bash"];
    case "delegate":
      return ["delegate_agent"];
    case "task":
      return ["task_create"];
    case "script":
      return scriptCoveredTools(node);
    default:
      return [];
  }
}

function scriptCoveredTools(node: WorkflowNodeDefinition): string[] {
  const capabilities = node.script?.capabilities ?? [];
  const tools: string[] = [];
  if (capabilities.includes("read")) tools.push("read");
  if (capabilities.includes("write")) tools.push("write", "edit");
  if (capabilities.includes("shell")) tools.push("bash");
  if (capabilities.includes("agent")) tools.push("delegate_agent");
  if (capabilities.includes("task")) tools.push("task_create");
  return tools;
}

function toolProvider(
  tool: string,
  declarations: WorkflowShadowDeclarations,
): ToolProvider | undefined {
  if (declarations.openModelTools) return { label: "open model tools" };
  const modelNode = declarations.modelTools.get(tool)?.[0];
  if (modelNode) return { label: `${modelNode}:model`, nodeId: modelNode };
  const nonModelNode = declarations.nonModelTools.get(tool)?.[0];
  if (nonModelNode) {
    return { label: `${nonModelNode}:non-model`, nodeId: nonModelNode };
  }
  return undefined;
}

function diffScopeProvider(
  path: string,
  declarations: WorkflowShadowDeclarations,
): { nodeId: string; verifierId: string } | undefined {
  for (const scope of declarations.diffScopes) {
    if (!scope.include || scope.include.length === 0) {
      return { nodeId: scope.nodeId, verifierId: scope.verifierId };
    }
    if (scope.include.some((pattern) => pathMatchesScope(pattern, path))) {
      return { nodeId: scope.nodeId, verifierId: scope.verifierId };
    }
  }
  return undefined;
}

function pathMatchesScope(pattern: string, path: string): boolean {
  if (pattern === path || pattern === "**" || pattern === "**/*") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const rest = path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1)
      : "";
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

function commandDefinitionString(
  command: WorkflowCommandNodeDefinition,
): string {
  if (
    command.command === "bash" &&
    command.args?.[0] === "-lc" &&
    typeof command.args[1] === "string"
  ) {
    return command.args[1];
  }
  return commandTokens(command.command, command.args);
}

function verifierCommandString(
  verifier: WorkflowCommandVerifierDefinition,
): string {
  if (
    verifier.command === "bash" &&
    verifier.args?.[0] === "-lc" &&
    typeof verifier.args[1] === "string"
  ) {
    return verifier.args[1];
  }
  return commandTokens(verifier.command, verifier.args);
}

function commandTokens(command: string, args: readonly string[] = []): string {
  return [command, ...args].join(" ");
}

function summarizeChecks(
  checks: readonly WorkflowShadowCheck[],
  warnings: number,
): WorkflowShadowReport["summary"] {
  return {
    matched: checks.filter((check) => check.status === "matched").length,
    missing: checks.filter((check) => check.status === "missing").length,
    unobserved: checks.filter((check) => check.status === "unobserved").length,
    warnings,
  };
}

function addMapValue(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}
