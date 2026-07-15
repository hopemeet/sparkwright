import type {
  ContextItem,
  RunResult,
  SparkwrightEvent,
} from "@sparkwright/core";
import {
  auditTodoAfterTerminal,
  hasExternalProgressEvidence,
  readTodoLedger,
  renderTodoLedgerContext,
  summarizeTodoLedger,
  TODO_CONTINUATION_REQUIRED_TOOL,
  type TodoTerminalAuditDecision,
} from "./ledger.js";
import type { TodoLedger } from "./types.js";
import { runWorkflowRunChain } from "../workflows/run-chain.js";

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
  continuationToolAvailability?(
    toolName: string,
  ):
    | { available: true }
    | { available: false; toolName: string; reason?: string };
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
  let stalledContinuationCount = 0;
  // Baseline of completed items carried across rounds. A read-only run emits no
  // workspace.write/artifact events, so the event-only progress signal can
  // never fire for it — which previously meant every continuation looked
  // "stalled" and an honest investigation got nagged to the handoff. Counting
  // newly-completed ledger items is a safe complement: completions are
  // monotonic and bounded by the item count, so a model cannot use them to
  // spin the stall guard forever (at worst it completes every item, which ends
  // the loop). Status churn that does not raise the completed count still
  // counts as no progress.
  let prevCompleted = summarizeTodoLedger(await readLedgerFn()).completed;

  const chain = await runWorkflowRunChain<
    TodoContinuationRequest,
    TodoSupervisedRunOutput,
    TodoSupervisedRunResult
  >({
    runOnce: options.runOnce,
    decide: async ({ output, continuationCount }) => {
      const ledger = output.ledger ?? (await readLedgerFn());
      const completed = summarizeTodoLedger(ledger).completed;
      const progressed =
        hasExternalProgressEvidence(output.events ?? []) ||
        completed > prevCompleted;
      let decision = auditTodoAfterTerminal(ledger, {
        result: output.result,
        events: output.events,
        hasProgress: progressed,
        continuationCount,
        maxContinuations: options.maxContinuations,
        stalledContinuationCount,
        maxStalledContinuations: options.maxStalledContinuations,
      });
      if (decision.kind === "continue") {
        const availability = options.continuationToolAvailability?.(
          TODO_CONTINUATION_REQUIRED_TOOL,
        );
        if (availability?.available === false) {
          decision = {
            kind: "handoff",
            summary: decision.summary,
            reason: "required_tool_unavailable",
            message:
              `Todo ledger is unfinished, but continuation requires unavailable tool ` +
              `\`${availability.toolName}\`` +
              (availability.reason ? ` (${availability.reason}).` : "."),
          };
        }
      }
      await options.onDecision?.(decision);

      if (decision.kind !== "continue") {
        return {
          kind: "terminal",
          terminal: {
            result: output.result,
            ledger,
            decision,
            continuationCount,
            stalledContinuationCount,
          },
        };
      }

      const nextContinuationCount = continuationCount + 1;
      stalledContinuationCount = progressed ? 0 : stalledContinuationCount + 1;
      prevCompleted = completed;
      return {
        kind: "continue",
        continuation: {
          prompt: decision.prompt,
          context: renderTodoLedgerContext(ledger, {
            sessionId: options.sessionId,
            title: "Current todo ledger for continuation",
          }),
          metadata: {
            synthetic: true,
            source: "todo_supervisor",
            reason: "unfinished_todo",
            continuationCount: nextContinuationCount,
          },
        },
      };
    },
  });

  return chain.terminal;
}

function resolveReadLedger(
  options: RunTodoSupervisedOptions,
): () => Promise<TodoLedger> | TodoLedger {
  if (options.readLedger) return options.readLedger;
  if (options.todoPath) return () => readTodoLedger(options.todoPath!);
  throw new Error("runTodoSupervised requires readLedger or todoPath.");
}
