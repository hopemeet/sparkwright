// AI maintenance note: Barrel for the todo subsystem. Keep this file purely a
// re-export surface — public API additions belong in the individual modules
// so JSDoc/`@stability` tags stay with their definitions.

export type {
  TodoEvidence,
  TodoItem,
  TodoLedger,
  TodoOwner,
  TodoPriority,
  TodoStatus,
  TodoSummary,
} from "./types.js";
export { TODO_INDENT_WIDTH } from "./types.js";

export type { TodoEntry } from "./markdown.js";
export {
  itemsOnly,
  parseTodoMarkdown,
  serializeTodoMarkdown,
} from "./markdown.js";

export type { CreateTodoToolsOptions, TodoWriteResult } from "./tools.js";
export { createTodoTools, createTodoWriteTool } from "./tools.js";

export type {
  TodoTerminalAuditDecision,
  TodoTerminalAuditOptions,
} from "./ledger.js";
export {
  auditTodoAfterTerminal,
  buildTodoContinuationPrompt,
  hasExternalProgressEvidence,
  hasUnfinishedTodo,
  readTodoLedger,
  renderTodoLedgerContext,
  summarizeTodoLedger,
  unfinishedTodoItems,
  writeTodoLedger,
} from "./ledger.js";

export type {
  RunTodoSupervisedOptions,
  TodoContinuationRequest,
  TodoSupervisedRunInput,
  TodoSupervisedRunOutput,
  TodoSupervisedRunResult,
} from "./supervisor.js";
export { runTodoSupervised } from "./supervisor.js";
