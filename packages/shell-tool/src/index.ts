// AI maintenance note: Public entry. Keep exports minimal and intention-aligned
// with the README — every symbol here is part of the v0.1 experimental surface.

export {
  DESTRUCTIVE_PATTERNS,
  isDestructive,
  type DestructiveScanResult,
} from "./destructive-patterns.js";
export { parseCommand, type ParsedCommand } from "./command-parser.js";
export {
  evaluateShellSafety,
  type ShellSafetyDecision,
  type ShellSafetyOptions,
  type ShellSafetyResult,
} from "./safety.js";
export {
  createShellTool,
  RECOMMENDED_FOREGROUND_TIMEOUT_MS,
  ShellSafetyError,
  type ShellPromotionHandler,
  type ShellPromotionRequest,
  type ShellPromotionResult,
  type ShellToolInput,
  type ShellToolOptions,
  type ShellToolOutput,
} from "./tool.js";
