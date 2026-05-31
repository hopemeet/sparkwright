// AI maintenance note: Optional preprocessing pass for skill bodies. Two
// transformations are supported: template-variable substitution (always safe)
// and inline-shell expansion (default OFF — it executes commands at load
// time, which only makes sense inside a host that has already granted the
// skill the relevant capability).

import { spawnSync } from "node:child_process";

const TEMPLATE_RE = /\$\{(SPARKWRIGHT_SKILL_DIR|SPARKWRIGHT_SESSION_ID)\}/g;
const INLINE_SHELL_RE = /!`([^`\n]+)`/g;
const DEFAULT_MAX_OUTPUT = 4000;

/**
 * Options for {@link preprocessSkillContent}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface PreprocessSkillOptions {
  /** Used to resolve `${SPARKWRIGHT_SKILL_DIR}` and as `cwd` for inline shell. */
  skillDir?: string;
  /** Used to resolve `${SPARKWRIGHT_SESSION_ID}`. */
  sessionId?: string;
  /** Enable backtick-shell expansion. **Default: false** — this executes commands. */
  inlineShell?: boolean;
  /** Inline-shell timeout in milliseconds. Default 10_000. */
  inlineShellTimeoutMs?: number;
  /** Hard cap on each inline-shell stdout. Default 4000 chars. */
  maxOutputChars?: number;
}

/**
 * Substitute `${SPARKWRIGHT_SKILL_DIR}` / `${SPARKWRIGHT_SESSION_ID}` tokens
 * and (when explicitly enabled) expand inline `` !`cmd` `` snippets. Tokens
 * whose value is unavailable are left in place verbatim so authors can spot
 * them.
 *
 * `inlineShell` is **OFF by default**. Enabling it executes arbitrary shell
 * commands; gate it behind your host's capability/approval layer.
 *
 * @public
 * @stability experimental v0.1
 */
export function preprocessSkillContent(
  content: string,
  options: PreprocessSkillOptions = {},
): string {
  if (!content) return content;
  let out = substituteTemplateVars(content, options);
  if (options.inlineShell) out = expandInlineShell(out, options);
  return out;
}

/** @internal */
export function substituteTemplateVars(
  content: string,
  options: Pick<PreprocessSkillOptions, "skillDir" | "sessionId">,
): string {
  return content.replace(TEMPLATE_RE, (match, token: string) => {
    if (token === "SPARKWRIGHT_SKILL_DIR" && options.skillDir) {
      return options.skillDir;
    }
    if (token === "SPARKWRIGHT_SESSION_ID" && options.sessionId) {
      return options.sessionId;
    }
    return match;
  });
}

/** @internal */
export function expandInlineShell(
  content: string,
  options: PreprocessSkillOptions,
): string {
  if (!content.includes("!`")) return content;
  const timeoutMs = options.inlineShellTimeoutMs ?? 10_000;
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

  return content.replace(INLINE_SHELL_RE, (_match, raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return "";
    return runInlineShell(cmd, options.skillDir, timeoutMs, maxOutput);
  });
}

function runInlineShell(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  maxOutput: number,
): string {
  try {
    const result = spawnSync("bash", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    if (result.error) {
      // ETIMEDOUT manifests via .signal === "SIGTERM" on some platforms.
      if (result.signal === "SIGTERM") {
        return `[inline-shell timeout after ${timeoutMs}ms: ${command}]`;
      }
      return `[inline-shell error: ${result.error.message}]`;
    }
    if (result.signal === "SIGTERM") {
      return `[inline-shell timeout after ${timeoutMs}ms: ${command}]`;
    }
    let output = (result.stdout ?? "").replace(/\n$/, "");
    if (!output && result.stderr) output = result.stderr.replace(/\n$/, "");
    if (output.length > maxOutput)
      output = `${output.slice(0, maxOutput)}...[truncated]`;
    return output;
  } catch (cause) {
    return `[inline-shell error: ${(cause as Error).message}]`;
  }
}
