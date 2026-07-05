/**
 * Workflow-owned run-chain driver for P3's degenerate workflow bridge.
 *
 * The caller still owns how to create each episode/run; this driver owns the
 * "run once, inspect terminal evidence, maybe continue" loop shape so host
 * supervisors and future workflow episodes can converge on one chain driver.
 */

export interface WorkflowRunChainStepInput<TContinuation> {
  continuation?: TContinuation;
  continuationCount: number;
}

export interface WorkflowRunChainDecisionInput<TContinuation, TOutput> {
  output: TOutput;
  continuation?: TContinuation;
  continuationCount: number;
}

export type WorkflowRunChainDecision<TContinuation, TTerminal> =
  | {
      kind: "continue";
      continuation: TContinuation;
    }
  | {
      kind: "terminal";
      terminal: TTerminal;
    };

export interface RunWorkflowRunChainOptions<TContinuation, TOutput, TTerminal> {
  runOnce(
    input: WorkflowRunChainStepInput<TContinuation>,
  ): Promise<TOutput> | TOutput;
  decide(
    input: WorkflowRunChainDecisionInput<TContinuation, TOutput>,
  ):
    | Promise<WorkflowRunChainDecision<TContinuation, TTerminal>>
    | WorkflowRunChainDecision<TContinuation, TTerminal>;
}

export interface WorkflowRunChainResult<TTerminal> {
  terminal: TTerminal;
  continuationCount: number;
}

export async function runWorkflowRunChain<TContinuation, TOutput, TTerminal>(
  options: RunWorkflowRunChainOptions<TContinuation, TOutput, TTerminal>,
): Promise<WorkflowRunChainResult<TTerminal>> {
  let continuation: TContinuation | undefined;
  let continuationCount = 0;

  while (true) {
    const output = await options.runOnce({
      continuation,
      continuationCount,
    });
    const decision = await options.decide({
      output,
      continuation,
      continuationCount,
    });

    if (decision.kind === "terminal") {
      return {
        terminal: decision.terminal,
        continuationCount,
      };
    }

    continuation = decision.continuation;
    continuationCount += 1;
  }
}
