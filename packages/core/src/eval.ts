import { isDeepStrictEqual } from "node:util";
import type { SparkwrightEvent } from "./events.js";
import { isRecord } from "./record-utils.js";

export type TrajectoryFindingSeverity = "info" | "warning" | "error";

export interface TrajectoryFinding {
  code: string;
  message: string;
  severity: TrajectoryFindingSeverity;
  eventSequence?: number;
  metadata?: Record<string, unknown>;
}

export interface TrajectoryEvalOptions {
  allowedTools?: string[];
  maxModelCalls?: number;
  maxToolCalls?: number;
  repeatedToolCallLimit?: number;
}

export interface TrajectoryEvalResult {
  status: "passed" | "failed";
  findings: TrajectoryFinding[];
  metrics: {
    modelCalls: number;
    toolCalls: number;
    failedToolCalls: number;
    retryCount: number;
    budgetCheckCount: number;
  };
}

const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;
const BUDGET_STOP_REASONS = new Set([
  "max_duration_exceeded",
  "max_model_calls_exceeded",
  "max_tool_calls_exceeded",
  "token_budget_exceeded",
  "cost_budget_exceeded",
]);

export function evaluateTrajectory(
  events: SparkwrightEvent[],
  options: TrajectoryEvalOptions = {},
): TrajectoryEvalResult {
  const findings: TrajectoryFinding[] = [];
  const allowedTools =
    options.allowedTools === undefined
      ? undefined
      : new Set(options.allowedTools);
  const repeatedToolCallLimit =
    options.repeatedToolCallLimit ?? DEFAULT_REPEATED_TOOL_CALL_LIMIT;
  let modelCalls = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let retryCount = 0;
  let budgetCheckCount = 0;
  let previousToolCall:
    | { toolName: string; arguments: unknown; sequence: number }
    | undefined;
  let repeatedToolCallCount = 0;

  for (const event of events) {
    switch (event.type) {
      case "model.requested":
        modelCalls += 1;
        break;
      case "model.retrying":
        retryCount += 1;
        break;
      case "run.budget.checked":
        budgetCheckCount += 1;
        break;
      case "tool.requested": {
        toolCalls += 1;
        const toolCall = readToolCall(event);

        if (
          allowedTools !== undefined &&
          toolCall.toolName !== undefined &&
          !allowedTools.has(toolCall.toolName)
        ) {
          findings.push({
            code: "UNAUTHORIZED_TOOL",
            message: `Tool is not allowed for this trajectory: ${toolCall.toolName}`,
            severity: "error",
            eventSequence: event.sequence,
            metadata: {
              toolName: toolCall.toolName,
              allowedTools: [...allowedTools],
            },
          });
        }

        if (
          previousToolCall &&
          toolCall.toolName === previousToolCall.toolName &&
          isDeepStrictEqual(toolCall.arguments, previousToolCall.arguments)
        ) {
          repeatedToolCallCount += 1;
        } else {
          repeatedToolCallCount = 1;
        }

        if (
          toolCall.toolName !== undefined &&
          repeatedToolCallCount === repeatedToolCallLimit
        ) {
          findings.push({
            code: "REPEATED_TOOL_CALL",
            message: `Tool call repeated ${repeatedToolCallCount} times without intervening progress: ${toolCall.toolName}`,
            severity: "error",
            eventSequence: event.sequence,
            metadata: {
              toolName: toolCall.toolName,
              repeatedToolCallCount,
              repeatedToolCallLimit,
              firstRepeatedSequence: previousToolCall?.sequence,
            },
          });
        }

        previousToolCall = {
          toolName: toolCall.toolName ?? "unknown",
          arguments: toolCall.arguments,
          sequence: event.sequence,
        };
        break;
      }
      case "tool.failed":
        failedToolCalls += 1;
        break;
      case "run.failed": {
        const reason = readString(event.payload, "reason");
        if (reason && BUDGET_STOP_REASONS.has(reason)) {
          findings.push({
            code: "BUDGET_EXHAUSTED",
            message: `Run stopped because a budget was exhausted: ${reason}`,
            severity: "error",
            eventSequence: event.sequence,
            metadata: { reason },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  if (
    options.maxModelCalls !== undefined &&
    modelCalls > options.maxModelCalls
  ) {
    findings.push({
      code: "MODEL_CALL_LIMIT_EXCEEDED",
      message: `Trajectory used ${modelCalls} model calls, above the limit of ${options.maxModelCalls}.`,
      severity: "error",
      metadata: {
        modelCalls,
        maxModelCalls: options.maxModelCalls,
      },
    });
  }

  if (options.maxToolCalls !== undefined && toolCalls > options.maxToolCalls) {
    findings.push({
      code: "TOOL_CALL_LIMIT_EXCEEDED",
      message: `Trajectory used ${toolCalls} tool calls, above the limit of ${options.maxToolCalls}.`,
      severity: "error",
      metadata: {
        toolCalls,
        maxToolCalls: options.maxToolCalls,
      },
    });
  }

  return {
    status: findings.some((finding) => finding.severity === "error")
      ? "failed"
      : "passed",
    findings,
    metrics: {
      modelCalls,
      toolCalls,
      failedToolCalls,
      retryCount,
      budgetCheckCount,
    },
  };
}

function readToolCall(event: SparkwrightEvent): {
  toolName?: string;
  arguments: unknown;
} {
  if (!isRecord(event.payload)) return { arguments: undefined };

  return {
    toolName: readString(event.payload, "toolName"),
    arguments: event.payload.arguments,
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;

  const result = value[key];
  return typeof result === "string" ? result : undefined;
}
