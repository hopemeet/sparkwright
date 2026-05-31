// AI maintenance note: Pure safety classifier. Given a raw command string this
// returns one of three decisions: allow, require_approval, or deny. The rules
// here are *advisory* and should always be paired with the core policy layer
// and an ExecutionEnvironment that re-validates at execute time.

import { isDestructive } from "./destructive-patterns.js";
import { parseCommand } from "./command-parser.js";

/**
 * Tri-state safety decision returned by {@link evaluateShellSafety}.
 *
 * @public
 * @stability experimental v0.1
 */
export type ShellSafetyDecision = "allow" | "require_approval" | "deny";

/**
 * Options that override default classification for individual programs or
 * categories. Each list takes precedence over built-in rules and is matched
 * against the leading program token (lowercased).
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellSafetyOptions {
  allow?: readonly string[];
  requireApproval?: readonly string[];
  deny?: readonly string[];
  /**
   * When false, the default heuristic of "unknown command → require_approval"
   * is replaced with "unknown command → deny". Defaults to true.
   */
  defaultRequireApproval?: boolean;
}

/**
 * Outcome of safety classification.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellSafetyResult {
  decision: ShellSafetyDecision;
  reason: string;
}

const ALLOW_PROGRAMS = new Set([
  "cd",
  "ls",
  "cat",
  "echo",
  "pwd",
  "true",
  "false",
]);

const ALLOW_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);

const APPROVAL_PROGRAMS = new Set([
  "sudo",
  "apt",
  "apt-get",
  "brew",
  "yum",
  "dnf",
  "pip",
  "pip3",
  "pipx",
  "gem",
  "cargo",
  "make",
  "docker",
  "kubectl",
  "ssh",
  "scp",
  "rsync",
]);

/**
 * Classify a shell command as allow / require_approval / deny.
 *
 * Order of evaluation:
 *
 * 1. Caller-provided `options.deny` / `allow` / `requireApproval` overrides.
 * 2. Hard-deny via {@link isDestructive}.
 * 3. Pipe into a shell interpreter → deny.
 * 4. Built-in program tables (allow / require_approval).
 * 5. `git push` / `npm install` style require-approval heuristics.
 * 6. Default decision (controlled by `defaultRequireApproval`).
 *
 * @public
 * @stability experimental v0.1
 */
export function evaluateShellSafety(
  command: string,
  options: ShellSafetyOptions = {},
): ShellSafetyResult {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { decision: "deny", reason: "Command is empty." };
  }

  const parsed = parseCommand(trimmed);
  const program = parsed.leadingProgram.toLowerCase();

  if (matchesList(program, options.deny)) {
    return {
      decision: "deny",
      reason: `Program "${program}" is on the deny list.`,
    };
  }

  const destructive = isDestructive(trimmed);
  if (destructive.destructive) {
    return {
      decision: "deny",
      reason: `Matched destructive pattern: ${destructive.matchedPattern ?? "unknown"}.`,
    };
  }

  if (
    parsed.hasPipe &&
    /\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh)\b/.test(trimmed)
  ) {
    return {
      decision: "deny",
      reason: "Piping output directly into a shell interpreter is denied.",
    };
  }

  // Chain operators (`;`, `&&`, `||`, `&`) hide downstream commands from the
  // leading-program classifier. Anything more than a trivial sequence must
  // pass through approval — the destructive-pattern scan above still applies
  // to the full raw string, so categorical bans (rm -rf /, mkfs, …) remain
  // hard-denied even when chained.
  if (parsed.hasChain) {
    return {
      decision: "require_approval",
      reason:
        "Command contains shell chain operators (;, &&, ||, &) and cannot be classified by program alone.",
    };
  }

  if (matchesList(program, options.allow)) {
    return {
      decision: "allow",
      reason: `Program "${program}" is on the allow list.`,
    };
  }
  if (matchesList(program, options.requireApproval)) {
    return {
      decision: "require_approval",
      reason: `Program "${program}" requires approval per options.`,
    };
  }

  if (program === "git") {
    const subcommand = (parsed.argv[1] ?? "").toLowerCase();
    if (ALLOW_GIT_SUBCOMMANDS.has(subcommand)) {
      return {
        decision: "allow",
        reason: `Read-only git subcommand: ${subcommand}.`,
      };
    }
    if (subcommand === "push") {
      return {
        decision: "require_approval",
        reason: "git push requires approval.",
      };
    }
  }

  if (
    (program === "npm" || program === "pnpm" || program === "yarn") &&
    parsed.argv[1]?.toLowerCase() === "install"
  ) {
    return {
      decision: "require_approval",
      reason: `${program} install requires approval.`,
    };
  }

  if (ALLOW_PROGRAMS.has(program)) {
    return { decision: "allow", reason: `Built-in safe program: ${program}.` };
  }

  if (APPROVAL_PROGRAMS.has(program)) {
    return {
      decision: "require_approval",
      reason: `Program "${program}" requires approval.`,
    };
  }

  const defaultRequireApproval = options.defaultRequireApproval ?? true;
  return defaultRequireApproval
    ? {
        decision: "require_approval",
        reason: `Unrecognized program "${program}" defaults to approval.`,
      }
    : {
        decision: "deny",
        reason: `Unrecognized program "${program}" denied by default.`,
      };
}

function matchesList(
  program: string,
  list: readonly string[] | undefined,
): boolean {
  if (!list || list.length === 0) return false;
  return list.some((entry) => entry.toLowerCase() === program);
}
