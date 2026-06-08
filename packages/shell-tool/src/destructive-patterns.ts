// AI maintenance note: This file enumerates *hard-deny* regex patterns for the
// shell tool. Treat the list as a safety floor, not a sufficient sandbox.
// Patterns are intentionally narrow: avoid broad word matches that would block
// benign commands. When adding a pattern, also add at least two fixture strings
// in the test file so the matcher cannot silently degrade.

/**
 * Regexes that identify shell commands that are categorically destructive
 * enough to be denied outright, regardless of approval state.
 *
 * @public
 * @stability experimental v0.1
 */
export const DESTRUCTIVE_PATTERNS: readonly RegExp[] = Object.freeze([
  // rm -rf targeting filesystem root, home, or wildcard expansion.
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\s+(?:\/(?:\s|$)|\/\s|~(?:\/|\s|$)|\*)/,
  // rm -rf targeting the current/parent directory or a relative wildcard.
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\s+(?:\.{1,2}(?:\/|\s|$)|\.?\/?\*(?:\s|$))/,
  // Fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // mkfs.* against any device.
  /\bmkfs(?:\.[a-z0-9]+)?\b/,
  // dd writing to a raw device.
  /\bdd\b[^|;&]*\bof=\/dev\/[a-z0-9]+/,
  // Redirect into a raw disk device.
  />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+|hd[a-z]|disk\d+)\b/,
  // curl/wget piped to a shell interpreter.
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh)\b/,
  // chmod -R 777 against the filesystem root.
  /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*|-R)\s+0?777\s+\/(?:\s|$)/,
  // Force-push to main/master.
  /\bgit\s+push\s+(?:--force\b|-f\b)[^;&|]*\b(?:main|master)\b/,
  // git reset --hard against an upstream branch.
  /\bgit\s+reset\s+--hard\s+origin\//,
  // sudo wrapping any of the destructive primitives above.
  /\bsudo\s+(?:rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)|mkfs|dd\b[^|;&]*\bof=\/dev\/|chmod\s+(?:-R\s+)?0?777\s+\/)/,
]);

/**
 * Result of a destructive-pattern scan.
 *
 * @public
 * @stability experimental v0.1
 */
export interface DestructiveScanResult {
  destructive: boolean;
  matchedPattern?: string;
}

/**
 * Tests a raw command string against {@link DESTRUCTIVE_PATTERNS}.
 *
 * Returns the first matching pattern (stringified) when the command is
 * considered destructive. The matcher is regex-only — it does not parse shell
 * grammar — so callers must combine it with safer parsing for nuanced cases.
 *
 * @public
 * @stability experimental v0.1
 */
export function isDestructive(command: string): DestructiveScanResult {
  const normalized = command.trim();
  if (normalized.length === 0) {
    return { destructive: false };
  }
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { destructive: true, matchedPattern: pattern.source };
    }
  }
  return { destructive: false };
}
