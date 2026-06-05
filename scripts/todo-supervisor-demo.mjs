// Standalone demo of the todo "mode" (todo-ledger supervisor).
//
// Why this script exists: the supervisor is a LIBRARY primitive in
// @sparkwright/agent-runtime. It is NOT wired into the host/CLI/TUI yet, so you
// cannot trigger it by typing in the TUI. This script drives it directly so you
// can watch the continuation loop fire.
//
// Run:  node scripts/todo-supervisor-demo.mjs
// (requires `npm run build` first, which compiles packages/agent-runtime/dist)

import { runTodoSupervised } from "@sparkwright/agent-runtime";

// An in-memory ledger that starts with two unfinished items. A real run would
// keep this in a markdown file and the model would edit it via `todo_write`.
let ledger = {
  schemaVersion: "todo-ledger.v1",
  metadata: {},
  items: [
    { title: "read the docs", status: "pending", depth: 0 },
    { title: "summarize each", status: "pending", depth: 0 },
  ],
};

let turn = 0;

const result = await runTodoSupervised({
  // The supervisor reads the ledger after every terminal run to decide whether
  // to continue. Here we just hand back our in-memory copy.
  readLedger: () => ledger,
  maxContinuations: 5,
  maxStalledContinuations: 2,

  // `runOnce` is YOUR agent turn. The supervisor calls it, then audits the
  // ledger. On a continuation it passes a synthetic request carrying an
  // authoritative todo context item + prompt.
  runOnce(input) {
    turn += 1;
    if (input.continuation) {
      console.log(
        `\n— continuation #${input.continuation.metadata.continuationCount} triggered —`,
      );
      console.log("  reason:", input.continuation.metadata.reason);
      console.log("  prompt:", input.continuation.prompt);
      console.log(
        "  ledger context source:",
        input.continuation.context.source?.kind,
      );
    } else {
      console.log("— first run —");
    }

    // Simulate the agent finishing one todo per turn (this is what a real model
    // would do via todo_write after doing the work).
    const next = ledger.items.findIndex((i) => i.status !== "completed");
    if (next >= 0) {
      const items = ledger.items.map((it, idx) =>
        idx === next ? { ...it, status: "completed" } : it,
      );
      ledger = { ...ledger, items };
      console.log(`  turn ${turn}: marked "${ledger.items[next].title}" done`);
    }

    return {
      // stopReason MUST be in the resumable set for auto-continue. `final_answer`
      // and `max_steps_exceeded` (your graceful wrap-up!) both qualify.
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        metadata: {},
      },
      // Progress evidence resets the "stalled" counter so the loop isn't killed.
      events: [{ type: "tool.completed" }],
    };
  },

  onDecision: (d) =>
    console.log(`  audit → ${d.kind}${d.reason ? ` (${d.reason})` : ""}`),
});

console.log("\n=== FINAL ===");
console.log("decision:", result.decision.kind, "/", result.decision.reason);
console.log("continuations:", result.continuationCount);
console.log(
  "ledger:",
  result.ledger.items.map((i) => `${i.title}=${i.status}`).join(", "),
);
