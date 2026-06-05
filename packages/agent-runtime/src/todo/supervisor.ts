import type {
  ContextItem,
  RunResult,
  SparkwrightEvent,
} from "@sparkwright/core";
import {
  auditTodoAfterTerminal,
  readTodoLedger,
  renderTodoLedgerContext,
  type TodoTerminalAuditDecision,
} from "./ledger.js";
import type { TodoLedger } from "./types.js";

export interface TodoContinuationRequest {
  prompt: string;
  context: ContextItem;
  metadata: {
    synthetic: true;
    source: "todo_supervisor";
    reason: "unfinished_todo";
    continuationCount: number;
  };
}

export interface TodoSupervisedRunInput {
  continuation?: TodoContinuationRequest;
  continuationCount: number;
}

export interface TodoSupervisedRunOutput {
  result: RunResult;
  events?: readonly SparkwrightEvent[];
  ledger?: TodoLedger;
}

export interface RunTodoSupervisedOptions {
  todoPath?: string;
  readLedger?: () => Promise<TodoLedger> | TodoLedger;
  runOnce(
    input: TodoSupervisedRunInput,
  ): Promise<TodoSupervisedRunOutput> | TodoSupervisedRunOutput;
  maxContinuations?: number;
  maxStalledContinuations?: number;
  sessionId?: string;
  onDecision?(decision: TodoTerminalAuditDecision): void | Promise<void>;
}

export interface TodoSupervisedRunResult {
  result: RunResult;
  ledger: TodoLedger;
  decision: TodoTerminalAuditDecision;
  continuationCount: number;
  stalledContinuationCount: number;
}

/**
 * Run a caller-owned agent loop under a todo terminal audit. The supervisor
 * never calls the model directly; it asks `runOnce` to create ordinary runs or
 * session turns. Continuations are passed as synthetic requests with an
 * authoritative todo context item.
 *
 * @public
 * @stability experimental v0.1
 */
export async function runTodoSupervised(
  options: RunTodoSupervisedOptions,
): Promise<TodoSupervisedRunResult> {
  const readLedgerFn = resolveReadLedger(options);
  let continuation: TodoContinuationRequest | undefined;
  let continuationCount = 0;
  let stalledContinuationCount = 0;

  while (true) {
    const output = await options.runOnce({
      continuation,
      continuationCount,
    });
    const ledger = output.ledger ?? (await readLedgerFn());
    const decision = auditTodoAfterTerminal(ledger, {
      result: output.result,
      events: output.events,
      continuationCount,
      maxContinuations: options.maxContinuations,
      stalledContinuationCount,
      maxStalledContinuations: options.maxStalledContinuations,
    });
    await options.onDecision?.(decision);

    if (decision.kind !== "continue") {
      return {
        result: output.result,
        ledger,
        decision,
        continuationCount,
        stalledContinuationCount,
      };
    }

    const progressed =
      output.events?.some(
        (event) =>
          event.type === "workspace.write.completed" ||
          event.type === "artifact.created" ||
          event.type === "tool.completed",
      ) ?? false;
    stalledContinuationCount = progressed ? 0 : stalledContinuationCount + 1;
    continuationCount += 1;
    continuation = {
      prompt: decision.prompt,
      context: renderTodoLedgerContext(ledger, {
        sessionId: options.sessionId,
        title: "Current todo ledger for continuation",
      }),
      metadata: {
        synthetic: true,
        source: "todo_supervisor",
        reason: "unfinished_todo",
        continuationCount,
      },
    };
  }
}

function resolveReadLedger(
  options: RunTodoSupervisedOptions,
): () => Promise<TodoLedger> | TodoLedger {
  if (options.readLedger) return options.readLedger;
  if (options.todoPath) return () => readTodoLedger(options.todoPath!);
  throw new Error("runTodoSupervised requires readLedger or todoPath.");
}
