// AI maintenance note: Barrel for the concurrency-control subsystem. Keep this
// file purely a re-export surface — public API additions belong in the
// individual modules so JSDoc/`@stability` tags stay with their definitions.

export type { AcquireResult, WritesClaim } from "./coordinator.js";
export { ConcurrencyCoordinator, globsOverlap } from "./coordinator.js";

export type {
  AcquireWorktreeOptions,
  MergeBackResult,
  WorktreeHandle,
} from "./worktree.js";
export { acquireWorktree } from "./worktree.js";

export type {
  ParseSubAgentResultOutcome,
  SubAgentResult,
  SubAgentStatus,
  WritesAuditResult,
} from "./result-protocol.js";
export {
  parseSubAgentResult,
  SUB_AGENT_RESULT_PROMPT,
  validateDeclaredWrites,
} from "./result-protocol.js";
