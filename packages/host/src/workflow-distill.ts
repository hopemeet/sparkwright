import { join } from "node:path";
import {
  asSessionId,
  loadTraceEventsFile,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { stringify as stringifyYaml } from "yaml";

export interface WorkflowDistillOptions {
  sessionRootDir: string;
  sessionId: string;
}

export interface WorkflowDistillObservedCommand {
  command: string;
  toolName: string;
  sequence: number;
}

export interface WorkflowDistillReport {
  ok: boolean;
  sessionId: string;
  tracePath: string;
  eventCount: number;
  assetName: string;
  goal?: string;
  terminalState?: string;
  observed: {
    tools: string[];
    readPaths: string[];
    writePaths: string[];
    verificationCommands: WorkflowDistillObservedCommand[];
  };
  warnings: string[];
  markdown: string;
}

interface RequestedTool {
  toolName: string;
  command?: string;
}

export async function distillWorkflowFromSession(
  options: WorkflowDistillOptions,
): Promise<WorkflowDistillReport> {
  const sessionId = asSessionId(options.sessionId);
  const tracePath = join(options.sessionRootDir, sessionId, "trace.jsonl");
  const events = await loadTraceEventsFile(tracePath);
  return distillWorkflowFromEvents({
    sessionId,
    tracePath,
    events,
  });
}

export function distillWorkflowFromEvents(input: {
  sessionId: string;
  tracePath: string;
  events: readonly SparkwrightEvent[];
}): WorkflowDistillReport {
  const events = [...input.events].sort((left, right) => {
    const leftSeq = left.sequence ?? 0;
    const rightSeq = right.sequence ?? 0;
    return leftSeq - rightSeq;
  });
  const goal = events
    .map((event) => stringValue(recordValue(event.payload)?.goal))
    .find((value): value is string => value !== undefined);
  const terminalState = [...events]
    .reverse()
    .map((event) =>
      event.type === "run.completed" || event.type === "run.failed"
        ? (stringValue(recordValue(event.payload)?.state) ?? event.type)
        : undefined,
    )
    .find((value): value is string => value !== undefined);
  const toolNames = uniqueStrings(
    events
      .filter((event) => event.type === "tool.requested")
      .map((event) => stringValue(recordValue(event.payload)?.toolName))
      .filter((value): value is string => value !== undefined)
      .map(normalizeWorkflowToolName)
      .filter((value): value is string => value !== undefined),
  );
  const readPaths = uniqueStrings(
    events
      .filter((event) => event.type === "workspace.read")
      .map((event) => stringValue(recordValue(event.payload)?.path))
      .filter((value): value is string => value !== undefined),
  );
  const writePaths = uniqueStrings(
    events
      .filter((event) => event.type === "workspace.write.completed")
      .map((event) => stringValue(recordValue(event.payload)?.path))
      .filter((value): value is string => value !== undefined),
  );
  const lastWriteSequence = events
    .filter((event) => event.type === "workspace.write.completed")
    .map((event) => event.sequence ?? 0)
    .at(-1);
  const requestedTools = requestedToolMap(events);
  const verificationCommands = collectVerificationCommands({
    events,
    requestedTools,
    afterSequence: lastWriteSequence,
  });
  const sawTodoWrite = events.some((event) => {
    const payload = recordValue(event.payload);
    return (
      event.type === "tool.requested" &&
      stringValue(payload?.toolName) === "todo_write"
    );
  });
  const warnings: string[] = [];
  if (terminalState !== "completed") {
    warnings.push(
      terminalState
        ? `source session terminal state is ${terminalState}, not completed`
        : "source session has no completed terminal event",
    );
  }
  if (writePaths.length > 0 && verificationCommands.length === 0) {
    warnings.push("no post-write verification command was observed");
  }
  if (toolNames.length === 0) {
    warnings.push("no model-facing tool requests were observed");
  }

  const assetName = `distilled-${slugify(goal ?? input.sessionId)}`;
  const markdown = renderWorkflowDraft({
    assetName,
    sessionId: input.sessionId,
    goal,
    tools: toolNames,
    readPaths,
    writePaths,
    verificationCommands,
    sawTodoWrite,
    warnings,
  });
  return {
    ok: terminalState === "completed",
    sessionId: input.sessionId,
    tracePath: input.tracePath,
    eventCount: events.length,
    assetName,
    ...(goal ? { goal } : {}),
    ...(terminalState ? { terminalState } : {}),
    observed: {
      tools: toolNames,
      readPaths,
      writePaths,
      verificationCommands,
    },
    warnings,
    markdown,
  };
}

function renderWorkflowDraft(input: {
  assetName: string;
  sessionId: string;
  goal?: string;
  tools: string[];
  readPaths: string[];
  writePaths: string[];
  verificationCommands: readonly WorkflowDistillObservedCommand[];
  sawTodoWrite: boolean;
  warnings: readonly string[];
}): string {
  const hasWrites = input.writePaths.length > 0;
  const inspectTools = uniqueStrings(
    ["read", "grep", "glob", ...input.tools].filter((tool) =>
      ["read", "grep", "glob", "todo_write"].includes(tool),
    ),
  );
  const implementationTools = uniqueStrings(
    ["read", ...(hasWrites ? ["edit", "write"] : []), ...input.tools].filter(
      (tool) => tool !== "todo_write",
    ),
  );
  const finalVerifier = [
    ...(hasWrites
      ? [
          {
            id: "distilled-diff-scope",
            kind: "diff_scope",
            include: input.writePaths,
          },
        ]
      : []),
    ...input.verificationCommands.slice(0, 3).map((command, index) => ({
      id: `distilled-verification-${index + 1}`,
      kind: "command",
      command: "bash",
      args: ["-lc", command.command],
      expect: "zero",
      authorized: true,
      metadata: {
        distilledFromTool: command.toolName,
        sourceSequence: command.sequence,
      },
    })),
    ...(input.sawTodoWrite
      ? [
          {
            id: "distilled-todo-clear",
            kind: "todo_clear",
          },
        ]
      : []),
  ];
  const nodes = hasWrites
    ? [
        {
          id: "inspect",
          execute: "model",
          tools: inspectTools,
          onPass: "implement",
        },
        {
          id: "implement",
          execute: "model",
          tools: implementationTools,
          ...(finalVerifier.length > 0 ? { verify: finalVerifier } : {}),
        },
      ]
    : [
        {
          id: "replay",
          execute: "model",
          tools: uniqueStrings([...inspectTools, ...implementationTools]),
          ...(finalVerifier.length > 0 ? { verify: finalVerifier } : {}),
        },
      ];
  const frontmatter = stringifyYaml({
    version: "0.1.0",
    description: `Distilled draft from session ${input.sessionId}`,
    metadata: {
      distilled: true,
      reviewRequired: true,
      sourceSessionId: input.sessionId,
      assetName: input.assetName,
      ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
    },
    nodes,
  }).trimEnd();
  const bodies = hasWrites
    ? [
        [
          "## inspect",
          "",
          input.goal
            ? `Understand the source task: ${input.goal}`
            : "Understand the source task from the session trace.",
          pathLine("Observed reads", input.readPaths),
          "Prepare the implementation plan before changing files.",
        ].join("\n"),
        [
          "## implement",
          "",
          hasWrites
            ? pathLine(
                "Limit workspace writes to the observed paths",
                input.writePaths,
              )
            : "Apply the distilled workflow intent.",
          verificationLine(input.verificationCommands),
          "Summarize what changed and cite the verification evidence.",
        ].join("\n"),
      ]
    : [
        [
          "## replay",
          "",
          input.goal
            ? `Recreate the useful workflow pattern from: ${input.goal}`
            : "Recreate the useful workflow pattern from the source session.",
          pathLine("Observed reads", input.readPaths),
          verificationLine(input.verificationCommands),
        ].join("\n"),
      ];
  return ["---", frontmatter, "---", "", ...bodies, ""].join("\n");
}

function collectVerificationCommands(input: {
  events: readonly SparkwrightEvent[];
  requestedTools: ReadonlyMap<string, RequestedTool>;
  afterSequence: number | undefined;
}): WorkflowDistillObservedCommand[] {
  const commands: WorkflowDistillObservedCommand[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (event.type !== "tool.completed") continue;
    if (
      input.afterSequence !== undefined &&
      (event.sequence ?? 0) <= input.afterSequence
    ) {
      continue;
    }
    const payload = recordValue(event.payload);
    const toolName = stringValue(payload?.toolName);
    if (!toolName || !isShellTool(toolName)) continue;
    if (stringValue(payload?.status) === "failed") continue;
    const callId =
      stringValue(payload?.toolCallId) ?? stringValue(payload?.id) ?? "";
    const requested = input.requestedTools.get(callId);
    const command =
      requested?.command ??
      commandFromRecord(payload) ??
      stringValue(payload?.command);
    if (!command || !isVerificationLikeCommand(command)) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push({
      command,
      toolName: normalizeWorkflowToolName(toolName) ?? toolName,
      sequence: event.sequence ?? 0,
    });
  }
  return commands;
}

function requestedToolMap(
  events: readonly SparkwrightEvent[],
): Map<string, RequestedTool> {
  const requested = new Map<string, RequestedTool>();
  for (const event of events) {
    if (event.type !== "tool.requested") continue;
    const payload = recordValue(event.payload);
    const id = stringValue(payload?.id) ?? stringValue(payload?.toolCallId);
    const toolName = stringValue(payload?.toolName);
    if (!id || !toolName) continue;
    requested.set(id, {
      toolName,
      command: commandFromRecord(recordValue(payload?.arguments)),
    });
  }
  return requested;
}

function commandFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) return undefined;
  for (const key of ["command", "cmd", "script", "run"]) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeWorkflowToolName(toolName: string): string | undefined {
  const normalized = toolName.trim();
  switch (normalized) {
    case "read_file":
    case "read":
      return "read";
    case "grep":
    case "search":
      return "grep";
    case "glob":
    case "list_dir":
      return "glob";
    case "write_file":
    case "write":
      return "write";
    case "edit_anchored_text":
    case "edit":
      return "edit";
    case "shell":
    case "bash":
      return "bash";
    case "todo_write":
      return "todo_write";
    case "delegate_agent":
    case "delegate_parallel":
    case "task_create":
      return normalized;
    default:
      return undefined;
  }
}

function isShellTool(toolName: string): boolean {
  const normalized = normalizeWorkflowToolName(toolName);
  return normalized === "bash";
}

function isVerificationLikeCommand(command: string): boolean {
  return /\b(test|tests|check|typecheck|lint|verify|build|release:check)\b/i.test(
    command,
  );
}

function pathLine(label: string, paths: readonly string[]): string {
  if (paths.length === 0) return `${label}: (none observed).`;
  return `${label}: ${paths.slice(0, 12).join(", ")}${paths.length > 12 ? ", ..." : ""}.`;
}

function verificationLine(
  commands: readonly WorkflowDistillObservedCommand[],
): string {
  if (commands.length === 0) {
    return "No post-write verification command was observed; choose an appropriate focused gate before relying on this draft.";
  }
  return `Observed verification: ${commands
    .slice(0, 3)
    .map((command) => command.command)
    .join("; ")}.`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workflow";
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
