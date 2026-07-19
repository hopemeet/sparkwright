import { join } from "node:path";
import {
  asSessionId,
  loadTraceEventsFile,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { stringify as stringifyYaml } from "yaml";
import {
  observeWorkflowTraceEvents,
  type WorkflowTraceObservedCommand,
} from "./workflow-trace-observation.js";

export interface WorkflowDistillOptions {
  sessionRootDir: string;
  sessionId: string;
}

export type WorkflowDistillObservedCommand = WorkflowTraceObservedCommand;

export interface WorkflowDistillReport {
  ok: boolean;
  sessionId: string;
  tracePath: string;
  eventCount: number;
  assetName: string;
  goal?: string;
  terminalState?: string;
  /** @reserved Public workflow-distill report field consumed by CLI/JSON report readers. */
  observed: {
    tools: string[];
    readPaths: string[];
    writePaths: string[];
    verificationCommands: WorkflowDistillObservedCommand[];
  };
  warnings: string[];
  markdown: string;
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
  const observation = observeWorkflowTraceEvents(input.events);
  const goal = observation.goal;
  const terminalState = observation.terminalState;
  const toolNames = observation.tools;
  const readPaths = observation.readPaths;
  const writePaths = observation.writePaths;
  const verificationCommands = observation.verificationCommands;
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
    warnings,
  });
  return {
    ok: terminalState === "completed",
    sessionId: input.sessionId,
    tracePath: input.tracePath,
    eventCount: observation.eventCount,
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
  warnings: readonly string[];
}): string {
  const hasWrites = input.writePaths.length > 0;
  const inspectTools = uniqueStrings(
    ["read", ...input.tools].filter((tool) =>
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
