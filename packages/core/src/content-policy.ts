/**
 * Content safety policy for text that will be injected into the system prompt
 * or otherwise trusted by the model — long-lived memory entries, skill bodies
 * pulled from disk, user-supplied "instructions" blobs, etc.
 *
 * A {@link ContentPolicy} runs cheap, deterministic checks before content
 * crosses a trust boundary into the model's context window. Defaults catch
 * common prompt-injection and exfiltration patterns plus zero-width unicode
 * smuggling, but the rule set is composable so embedders can layer their own
 * checks (e.g. PII detectors, project-specific allow lists).
 *
 * Policy is deliberately separate from the action-level {@link import("./policy.js").Policy}
 * surface: that one decides whether an action is allowed, denied, or needs
 * approval. Content policy decides whether a *string* is safe to persist or
 * inject. The two compose; they do not overlap.
 *
 * @packageDocumentation
 */

/**
 * Where the content originates. Lets policies relax for known-trusted callers
 * (e.g. a host-curated skill) without rewriting the rule list.
 *
 * @public
 * @stability experimental v0.1
 */
export type ContentSource =
  | "memory_write"
  | "skill_body"
  | "skill_instructions"
  | "user_input"
  | "tool_result"
  | "unknown";

/**
 * Result of a single rule. `kind: "ok"` is the default; `"block"` aborts the
 * write/load, `"warn"` lets it through but surfaces a diagnostic the host can
 * log or attach to a trace event.
 *
 * @public
 * @stability experimental v0.1
 */
export type ContentRuleResult =
  | { kind: "ok" }
  | { kind: "block"; ruleId: string; reason: string }
  | { kind: "warn"; ruleId: string; reason: string };

/**
 * A single content-safety rule. Receives the candidate text plus a context
 * descriptor; returns a result. Rules must be pure and synchronous-cheap;
 * async work belongs in a separate review step, not in this hot path.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ContentRule {
  readonly id: string;
  readonly description?: string;
  evaluate(text: string, ctx: { source: ContentSource }): ContentRuleResult;
}

/**
 * Combined outcome of running every rule against a piece of content.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ContentPolicyVerdict {
  /** True iff no rule returned `block`. */
  allowed: boolean;
  /** All blocking rule hits (empty when allowed). */
  blocks: Array<{ ruleId: string; reason: string }>;
  /** All non-blocking warnings (does not affect `allowed`). */
  warnings: Array<{ ruleId: string; reason: string }>;
}

/**
 * Layered policy that evaluates every rule and aggregates verdicts.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ContentPolicy {
  readonly rules: readonly ContentRule[];
  evaluate(text: string, source: ContentSource): ContentPolicyVerdict;
}

/**
 * Construct a {@link ContentPolicy} from a list of rules. Rules run in order;
 * blocks and warnings from every rule are collected (no short-circuit) so the
 * caller sees a complete picture of why content was rejected.
 *
 * @public
 * @stability experimental v0.1
 */
export function createContentPolicy(
  rules: readonly ContentRule[],
): ContentPolicy {
  return {
    rules,
    evaluate(text, source) {
      const blocks: Array<{ ruleId: string; reason: string }> = [];
      const warnings: Array<{ ruleId: string; reason: string }> = [];
      for (const rule of rules) {
        const result = rule.evaluate(text, { source });
        if (result.kind === "block") {
          blocks.push({ ruleId: result.ruleId, reason: result.reason });
        } else if (result.kind === "warn") {
          warnings.push({ ruleId: result.ruleId, reason: result.reason });
        }
      }
      return { allowed: blocks.length === 0, blocks, warnings };
    },
  };
}

/**
 * Default rule list used by {@link createDefaultContentPolicy}. Exposed so
 * embedders can drop individual rules they consider too strict.
 *
 * @public
 * @stability experimental v0.1
 */
export const DEFAULT_CONTENT_RULES: readonly ContentRule[] = [
  patternRule(
    "prompt_injection",
    /ignore\s+(previous|all|above|prior)\s+instructions/i,
  ),
  patternRule("role_hijack", /you\s+are\s+now\s+/i),
  patternRule("deception_hide", /do\s+not\s+tell\s+the\s+user/i),
  patternRule("sys_prompt_override", /system\s+prompt\s+override/i),
  patternRule(
    "disregard_rules",
    /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  ),
  patternRule(
    "bypass_restrictions",
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i,
  ),
  patternRule(
    "exfil_curl",
    /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  ),
  patternRule(
    "exfil_wget",
    /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  ),
  patternRule(
    "read_secrets",
    /cat\s+[^\n]*(\.env\b|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
  ),
  patternRule("ssh_backdoor", /authorized_keys/i),
  zeroWidthUnicodeRule(),
];

/**
 * Construct the default content policy. Pass `extras` to layer additional
 * rules without rewriting the defaults.
 *
 * @public
 * @stability experimental v0.1
 */
export function createDefaultContentPolicy(
  extras: readonly ContentRule[] = [],
): ContentPolicy {
  return createContentPolicy([...DEFAULT_CONTENT_RULES, ...extras]);
}

// ---------------------------------------------------------------------------
// Rule constructors
// ---------------------------------------------------------------------------

/**
 * Build a simple regex-based blocking rule.
 *
 * @public
 * @stability experimental v0.1
 */
export function patternRule(id: string, pattern: RegExp): ContentRule {
  return {
    id,
    evaluate(text) {
      return pattern.test(text)
        ? {
            kind: "block",
            ruleId: id,
            reason: `Blocked by content rule '${id}'.`,
          }
        : { kind: "ok" };
    },
  };
}

const ZERO_WIDTH_CHARS = new Set([
  "​",
  "‌",
  "‍",
  "⁠",
  "﻿",
  "‪",
  "‫",
  "‬",
  "‭",
  "‮",
]);

/**
 * Block content carrying zero-width / bidi-override unicode characters
 * commonly used for invisible prompt smuggling.
 *
 * @public
 * @stability experimental v0.1
 */
// ---------------------------------------------------------------------------
// Secret redaction
//
// Distinct from the rule-based block/warn surface above: redaction rewrites
// text in place, replacing matched secrets with a `[REDACTED]` marker. Used
// before persisting summaries (which travel across sessions) and before
// emitting trace events that might leak credentials. The default pattern
// list errs toward false positives — better to over-redact a token-shaped
// string than to persist a real API key.
// ---------------------------------------------------------------------------

/**
 * A single redaction pattern. `replacement` defaults to `[REDACTED]` when
 * omitted; pass a custom string to preserve a recognizable prefix
 * (e.g. `[REDACTED:github-pat]`) for debugging.
 *
 * @public
 * @stability experimental v0.1
 */
export interface RedactionPattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement?: string;
}

/**
 * Built-in patterns covering common cloud and developer-tool credential
 * shapes. Patterns are anchored to the full key shape rather than to
 * surrounding context so they match in JSON, env files, shell output,
 * and free-form prose alike.
 *
 * Designed for breadth, not depth: a host should layer its own
 * organization-specific patterns on top via `extras` in
 * {@link redactSensitiveText}.
 *
 * @public
 * @stability experimental v0.1
 */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
  // OpenAI / Anthropic-style API keys: prefix + ≥20 url-safe chars.
  { id: "openai_key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  // GitHub personal access tokens and app tokens.
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  // AWS access key id.
  { id: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Generic "KEY=value" / "KEY: value" assignments where the key name
  // implies a credential. Captures value characters up to whitespace,
  // quote, or end of line.
  {
    id: "env_secret_assignment",
    pattern:
      /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL[S]?))\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/g,
    replacement: "$1=[REDACTED]",
  },
  // Bearer tokens in Authorization headers / curl flags.
  {
    id: "bearer_token",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g,
    replacement: "Bearer [REDACTED]",
  },
  // PEM private key blocks.
  {
    id: "pem_private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
];

export interface RedactSensitiveTextOptions {
  /** Additional patterns layered after the defaults. */
  extras?: readonly RedactionPattern[];
  /** Drop default patterns and use only `extras`. */
  replaceDefaults?: boolean;
  /** Override the default `[REDACTED]` placeholder. */
  defaultReplacement?: string;
  /**
   * If provided, called once per match so the caller can track which
   * pattern ids fired (useful for trace/audit attribution).
   */
  onMatch?: (info: { id: string; original: string }) => void;
}

/**
 * Redact common credential shapes from `text`, returning a new string.
 * Pure and synchronous — safe to call on hot paths (trace serialization,
 * pre-summary preprocessing).
 *
 * Pattern semantics: each entry's `pattern` is applied with `String.replace`.
 * If the pattern includes a custom `replacement`, that string is used
 * (back-references like `$1` work as in standard `replace`); otherwise the
 * match is replaced with `[REDACTED]` (or `defaultReplacement`).
 *
 * @public
 * @stability experimental v0.1
 */
export function redactSensitiveText(
  text: string,
  options: RedactSensitiveTextOptions = {},
): string {
  if (!text) return text;
  const placeholder = options.defaultReplacement ?? "[REDACTED]";
  const base = options.replaceDefaults ? [] : DEFAULT_REDACTION_PATTERNS;
  const patterns: readonly RedactionPattern[] = [
    ...base,
    ...(options.extras ?? []),
  ];

  let out = text;
  for (const entry of patterns) {
    const replacement = entry.replacement ?? placeholder;
    if (!entry.pattern.global) {
      // Non-global regexes only replace the first match — promote to
      // global silently so callers don't trip over the difference.
      const promoted = new RegExp(
        entry.pattern.source,
        `${entry.pattern.flags}g`,
      );
      out = out.replace(promoted, (match) => {
        options.onMatch?.({ id: entry.id, original: match });
        return replacement;
      });
      continue;
    }
    out = out.replace(entry.pattern, (match) => {
      options.onMatch?.({ id: entry.id, original: match });
      return replacement;
    });
  }
  return out;
}

export function zeroWidthUnicodeRule(id = "zero_width_unicode"): ContentRule {
  return {
    id,
    evaluate(text) {
      for (const ch of text) {
        if (ZERO_WIDTH_CHARS.has(ch)) {
          return {
            kind: "block",
            ruleId: id,
            reason: `Content contains invisible unicode character U+${ch
              .codePointAt(0)!
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")} (possible injection).`,
          };
        }
      }
      return { kind: "ok" };
    },
  };
}
