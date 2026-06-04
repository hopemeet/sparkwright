// AI maintenance note: Deterministic keyword scorer for the discovery
// protocol. Intentionally simple: lowercased token intersection between the
// query and (name + description + triggers). The goal is to keep matcher
// behavior fully predictable and to let hosts swap in their own tokenizer
// (e.g. stemmed or locale-aware) without touching the registry. Embeddings
// or semantic search are explicitly out of scope here.

import type { SkillManifest, SkillMatch } from "./types.js";
import {
  recencyBoost,
  type SkillUsageRecorder,
  type SkillUsageState,
} from "./usage.js";

const DEFAULT_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "that",
  "the",
  "this",
  "when",
  "with",
  "asks",
  "skill",
  "skills",
  "agent",
  "agents",
  "a",
  "an",
  "of",
  "to",
  "is",
  "it",
  "on",
  "in",
  // High-frequency CJK filler bigrams. CJK is tokenized as overlapping
  // bigrams (see defaultTokenize), so stop entries are bigrams, not chars.
  "帮我",
  "一下",
  "帮忙",
  "怎么",
  "如何",
  "可以",
  "我想",
  "请问",
]);

// Matches a run of CJK Unified Ideographs (incl. common extensions). Used to
// split CJK segments out for bigram tokenization, since they carry no spaces.
const CJK_RUN = /[㐀-鿿豈-﫿]+/g;
const LATIN_RUN = /[a-z0-9]+/g;

/**
 * Options for {@link matchSkills}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface MatchSkillsOptions {
  /** Maximum number of matches to return. Default 5. */
  limit?: number;
  /** Include zero-score matches in the output. Default false. */
  includeZero?: boolean;
  /** Override the tokenizer for both queries and skills. */
  tokenize?: (input: string) => string[];
  /** Optional stop-word set used by the default tokenizer. */
  stopWords?: ReadonlySet<string>;
  /**
   * Optional usage recorder. When provided, scores get a recency boost of
   * up to {@link MatchSkillsOptions.recencyWeight} (default 2) and skills
   * whose state is in {@link MatchSkillsOptions.excludeStates} are dropped.
   */
  usage?: SkillUsageRecorder;
  /** Multiplier applied to the [0,1] recency boost. Default 2. */
  recencyWeight?: number;
  /** Multiplier applied to log(1 + useCount). Default 0.5. */
  frequencyWeight?: number;
  /** Skill states to exclude from the result. Default `["archived"]`. */
  excludeStates?: readonly SkillUsageState[];
  /** Current time, for deterministic tests. */
  now?: Date;
}

/**
 * Score `query` against each `skill` and return the best matches, sorted by
 * score descending (then by name ascending for stability).
 *
 * @public
 * @stability experimental v0.1
 */
export function matchSkills(
  query: string,
  skills: readonly SkillManifest[],
  options: MatchSkillsOptions = {},
): SkillMatch[] {
  const limit = options.limit ?? 5;
  const tokenize = options.tokenize ?? makeDefaultTokenizer(options.stopWords);
  const queryTokens = new Set(tokenize(query));
  const usage = options.usage;
  const recencyWeight = options.recencyWeight ?? 2;
  const frequencyWeight = options.frequencyWeight ?? 0.5;
  const excludeStates = new Set<SkillUsageState>(
    options.excludeStates ?? ["archived"],
  );
  const now = options.now ?? new Date();

  const matches: SkillMatch[] = skills.map((skill) => {
    const nameTokens = new Set(tokenize(skill.name));
    const descTokens = new Set(tokenize(skill.description));
    const triggerTokens = new Set(
      (skill.triggers ?? []).flatMap((trigger) => tokenize(trigger)),
    );

    const matchedKeywords: string[] = [];
    let score = 0;

    for (const token of queryTokens) {
      let local = 0;
      if (nameTokens.has(token)) local += 3;
      if (triggerTokens.has(token)) local += 2;
      if (descTokens.has(token)) local += 1;
      if (local > 0) {
        score += local;
        matchedKeywords.push(token);
      }
    }

    // Exact-name substring bonus, deterministic and case-insensitive.
    if (query.toLowerCase().includes(skill.name.toLowerCase())) score += 5;

    if (usage && score > 0) {
      const record = usage.get(skill.name);
      if (record) {
        score += recencyBoost(record.lastUsedAt, now) * recencyWeight;
        score += Math.log1p(record.useCount) * frequencyWeight;
      }
    }

    return { skill, score, matchedKeywords };
  });

  const filtered = (
    options.includeZero ? matches : matches.filter((m) => m.score > 0)
  ).filter((m) => {
    if (!usage) return true;
    const r = usage.get(m.skill.name);
    if (!r) return true;
    return !excludeStates.has(r.state);
  });

  filtered.sort(
    (left, right) =>
      right.score - left.score ||
      left.skill.name.localeCompare(right.skill.name),
  );

  return filtered.slice(0, limit);
}

/**
 * Default tokenizer used by {@link matchSkills}. Exposed so callers can wrap
 * or compose it.
 *
 * @public
 * @stability experimental v0.1
 */
export function defaultTokenize(
  input: string,
  stopWords: ReadonlySet<string> = DEFAULT_STOP_WORDS,
): string[] {
  const lower = input.toLowerCase();
  const tokens: string[] = [];

  // Latin/digit runs become whole-word tokens.
  for (const word of lower.match(LATIN_RUN) ?? []) {
    if (word.length > 1 && !stopWords.has(word)) tokens.push(word);
  }

  // CJK runs carry no spaces, so a per-character split over-matches ("测"
  // alone hits far too much). Emit overlapping bigrams instead; a single-char
  // run degrades to that char so it is never silently dropped.
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      if (!stopWords.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!stopWords.has(bigram)) tokens.push(bigram);
    }
  }

  return tokens;
}

function makeDefaultTokenizer(
  stopWords: ReadonlySet<string> | undefined,
): (input: string) => string[] {
  const set = stopWords ?? DEFAULT_STOP_WORDS;
  return (input: string) => defaultTokenize(input, set);
}
