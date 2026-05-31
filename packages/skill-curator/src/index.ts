// AI maintenance note: @sparkwright/skill-curator is the "self-improvement
// loop" for skills. It has three layers that compose cleanly:
//
//   1. STATE MACHINE (`applyAutomaticTransitions`) — pure, no LLM. Walks usage
//      records and demotes/archives by recency. Cheap; safe to run often.
//   2. PROVENANCE (`runBackgroundReview`) — AsyncLocalStorage flag that lets
//      `recordSkillCreated` distinguish skill_manage(create) calls made by a
//      background review fork from those made by the foreground agent. Only
//      the former should be tagged `agentCreated` (curators only touch their
//      own).
//   3. REVIEW REPORT (`renderCuratorPrompt`, `parseCuratorReport`) — the
//      structured deliverable produced by a forked LLM agent. The package
//      doesn't *run* the LLM (that belongs to the embedder); it owns the
//      prompt shape and the YAML-block parser so downstream tooling can
//      automate migration of references.
//
// The curator never deletes — archiving is the maximum destructive action.

export {
  applyAutomaticTransitions,
  type AutomaticTransitionsOptions,
  type AutomaticTransitionsResult,
} from "./state-machine.js";
export {
  runBackgroundReview,
  isBackgroundReview,
  markIfBackgroundReview,
} from "./provenance.js";
export {
  renderCuratorPrompt,
  CURATOR_DRY_RUN_BANNER,
  type RenderCuratorPromptOptions,
} from "./prompt.js";
export {
  parseCuratorReport,
  type CuratorReport,
  type CuratorConsolidation,
  type CuratorPruning,
} from "./report.js";
export {
  archiveSkillDirectory,
  restoreArchivedSkill,
  type ArchiveSkillOptions,
  type ArchiveSkillResult,
  type RestoreSkillOptions,
} from "./archive.js";
