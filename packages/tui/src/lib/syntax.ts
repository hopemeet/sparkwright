/**
 * Lightweight syntax tokenizer for terminal code blocks.
 *
 * This is deliberately NOT a real parser — it's a single-pass lexer that
 * classifies the few token kinds worth colouring (keywords, strings,
 * comments, numbers, decorators, string interpolation) and leaves everything
 * else plain. It's pure so it can be memoized and unit-tested without Ink.
 *
 * Keywords are chosen per language (so Python's `map`/`type`/`string`, which
 * are builtins rather than keywords, don't get mis-coloured the way a shared
 * cross-language table would colour them). Multi-line constructs (triple-quoted
 * Python strings, backtick template literals) are tracked across lines via an
 * opaque {@link LexState} threaded by {@link highlightLines}; the per-line
 * {@link highlightLine} starts from a clean state for the simple cases.
 */

export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "decorator"
  | "interp";

export interface Token {
  text: string;
  kind: TokenKind;
}

const JS_TS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "class",
  "extends",
  "super",
  "this",
  "typeof",
  "instanceof",
  "await",
  "async",
  "yield",
  "try",
  "catch",
  "finally",
  "throw",
  "import",
  "export",
  "from",
  "as",
  "default",
  "interface",
  "type",
  "enum",
  "implements",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "in",
  "of",
  "delete",
  "namespace",
  "declare",
  "abstract",
  "keyof",
  "infer",
  "satisfies",
]);

const PYTHON = new Set([
  "def",
  "lambda",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "with",
  "pass",
  "raise",
  "except",
  "try",
  "finally",
  "and",
  "or",
  "not",
  "in",
  "is",
  "None",
  "True",
  "False",
  "class",
  "import",
  "from",
  "as",
  "global",
  "nonlocal",
  "async",
  "await",
  "yield",
  "del",
  "assert",
  "break",
  "continue",
  "self",
  "cls",
  "match",
  "case",
]);

const GO = new Set([
  "func",
  "package",
  "import",
  "var",
  "const",
  "type",
  "struct",
  "interface",
  "map",
  "range",
  "go",
  "defer",
  "select",
  "chan",
  "if",
  "else",
  "for",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "default",
  "nil",
  "true",
  "false",
  "make",
  "new",
]);

const RUST = new Set([
  "fn",
  "let",
  "mut",
  "impl",
  "trait",
  "use",
  "match",
  "pub",
  "struct",
  "enum",
  "mod",
  "crate",
  "self",
  "super",
  "return",
  "if",
  "else",
  "for",
  "while",
  "loop",
  "break",
  "continue",
  "ref",
  "move",
  "async",
  "await",
  "dyn",
  "where",
  "type",
  "const",
  "static",
  "unsafe",
  "true",
  "false",
]);

const C_FAMILY = new Set([
  "int",
  "float",
  "double",
  "char",
  "void",
  "bool",
  "long",
  "short",
  "unsigned",
  "signed",
  "struct",
  "class",
  "public",
  "private",
  "protected",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "delete",
  "const",
  "static",
  "virtual",
  "override",
  "namespace",
  "using",
  "template",
  "typename",
  "true",
  "false",
  "null",
  "nullptr",
  "this",
  "throw",
  "try",
  "catch",
]);

// Languages whose line comment starts with `#`.
const HASH_LANGS = new Set([
  "py",
  "python",
  "rb",
  "ruby",
  "sh",
  "bash",
  "shell",
  "zsh",
  "yaml",
  "yml",
  "toml",
  "ini",
  "r",
  "perl",
  "pl",
]);
// Languages whose line comment starts with `--`.
const DASH_LANGS = new Set(["sql", "lua", "haskell", "hs"]);

const PYTHON_LANGS = new Set(["py", "python"]);
const JS_LANGS = new Set([
  "js",
  "javascript",
  "jsx",
  "ts",
  "tsx",
  "typescript",
  "mjs",
  "cjs",
]);
const GO_LANGS = new Set(["go", "golang"]);
const RUST_LANGS = new Set(["rs", "rust"]);
const C_LANGS = new Set([
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "java",
  "cs",
  "csharp",
  "kt",
  "kotlin",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
// A Python string prefix: f/r/b/u in any case, alone or paired (rb, fr, ...).
const STRING_PREFIX_RE = /^[rbfu]{1,2}$/i;

interface LangProfile {
  comment: string;
  keywords: Set<string>;
  /** `@decorator` syntax (Python, TS). */
  decorators: boolean;
  /** Python-style `f"..."`/`r"..."` string prefixes. */
  stringPrefix: boolean;
}

function profileFor(lang?: string): LangProfile {
  const l = (lang ?? "").toLowerCase();
  const comment = HASH_LANGS.has(l) ? "#" : DASH_LANGS.has(l) ? "--" : "//";
  if (PYTHON_LANGS.has(l))
    return { comment, keywords: PYTHON, decorators: true, stringPrefix: true };
  if (JS_LANGS.has(l))
    return { comment, keywords: JS_TS, decorators: true, stringPrefix: false };
  if (GO_LANGS.has(l))
    return { comment, keywords: GO, decorators: false, stringPrefix: false };
  if (RUST_LANGS.has(l))
    return { comment, keywords: RUST, decorators: false, stringPrefix: false };
  if (C_LANGS.has(l))
    return {
      comment,
      keywords: C_FAMILY,
      decorators: false,
      stringPrefix: false,
    };
  // Unknown / no language: fall back to the broad JS/TS set.
  return { comment, keywords: JS_TS, decorators: false, stringPrefix: false };
}

/** Cross-line lexer state. `pending` is the closing delimiter of an unclosed
 * multi-line string (`"""`, `'''`, or a backtick), or null at a clean break. */
export interface LexState {
  pending: string | null;
}

export const INITIAL_STATE: LexState = { pending: null };

/** Index of the `}` matching the `{` at `open`, balancing nesting; -1 if none. */
function matchBrace(line: string, open: number): number {
  let depth = 0;
  for (let k = open; k < line.length; k += 1) {
    if (line[k] === "{") depth += 1;
    else if (line[k] === "}") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

type Interp = "brace" | "dollar" | "none";

/**
 * Scan a string literal starting at `prefixStart` (which may include a Python
 * prefix like `f`); `quotePos` is the opening quote. Emits the literal as
 * `string` tokens and any interpolation (`{expr}` / `${expr}`) as `interp`.
 * Returns where the string ended and the carry-over delimiter if it didn't
 * close on this line.
 */
function scanString(
  line: string,
  prefixStart: number,
  quotePos: number,
  interp: Interp,
): { tokens: Token[]; end: number; pending: string | null } {
  const q = line[quotePos];
  const triple =
    line[quotePos + 1] === q && line[quotePos + 2] === q
      ? `${q}${q}${q}`
      : null;
  const tokens: Token[] = [];

  if (triple) {
    const closeIdx = line.indexOf(triple, quotePos + 3);
    if (closeIdx === -1) {
      tokens.push({ text: line.slice(prefixStart), kind: "string" });
      return { tokens, end: line.length, pending: triple };
    }
    tokens.push({
      text: line.slice(prefixStart, closeIdx + 3),
      kind: "string",
    });
    return { tokens, end: closeIdx + 3, pending: null };
  }

  let lit = line.slice(prefixStart, quotePos + 1); // prefix + opening quote
  const pushLit = (): void => {
    if (lit) tokens.push({ text: lit, kind: "string" });
    lit = "";
  };

  let i = quotePos + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      lit += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === q) {
      lit += c;
      i += 1;
      pushLit();
      return { tokens, end: i, pending: null };
    }
    if (interp === "brace" && c === "{") {
      if (line[i + 1] === "{") {
        lit += "{{";
        i += 2;
        continue;
      }
      const close = matchBrace(line, i);
      if (close !== -1) {
        pushLit();
        tokens.push({ text: line.slice(i, close + 1), kind: "interp" });
        i = close + 1;
        continue;
      }
    }
    if (interp === "brace" && c === "}" && line[i + 1] === "}") {
      lit += "}}";
      i += 2;
      continue;
    }
    if (interp === "dollar" && c === "$" && line[i + 1] === "{") {
      const close = matchBrace(line, i + 1);
      if (close !== -1) {
        pushLit();
        tokens.push({ text: line.slice(i, close + 1), kind: "interp" });
        i = close + 1;
        continue;
      }
    }
    lit += c;
    i += 1;
  }
  // Ran off the end of the line. A backtick stays open across lines; a single-
  // or double-quoted string is treated as closing here (per-line recovery).
  pushLit();
  return { tokens, end: line.length, pending: q === "`" ? "`" : null };
}

function tokenizeLine(
  line: string,
  profile: LangProfile,
  state: LexState,
): { tokens: Token[]; state: LexState } {
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) tokens.push({ text: plain, kind: "plain" });
    plain = "";
  };

  let i = 0;

  // Continuation of an unclosed multi-line string from a previous line.
  if (state.pending) {
    const close = state.pending;
    const idx = line.indexOf(close);
    if (idx === -1) {
      if (line.length) tokens.push({ text: line, kind: "string" });
      return { tokens, state };
    }
    tokens.push({ text: line.slice(0, idx + close.length), kind: "string" });
    i = idx + close.length;
    state = { pending: null };
  }

  while (i < line.length) {
    const rest = line.slice(i);

    if (rest.startsWith(profile.comment)) {
      flush();
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const ch = line[i];

    // Decorator: `@name`, `@a.b.c`.
    if (
      profile.decorators &&
      ch === "@" &&
      IDENT_START.test(line[i + 1] ?? "")
    ) {
      flush();
      let j = i + 1;
      while (j < line.length && (IDENT_PART.test(line[j]) || line[j] === "."))
        j += 1;
      tokens.push({ text: line.slice(i, j), kind: "decorator" });
      i = j;
      continue;
    }

    // Identifier, keyword, or Python string prefix.
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < line.length && IDENT_PART.test(line[j])) j += 1;
      const word = line.slice(i, j);
      const next = line[j];
      if (
        profile.stringPrefix &&
        (next === '"' || next === "'") &&
        STRING_PREFIX_RE.test(word)
      ) {
        flush();
        const interp: Interp = /f/i.test(word) ? "brace" : "none";
        const r = scanString(line, i, j, interp);
        tokens.push(...r.tokens);
        i = r.end;
        if (r.pending) return { tokens, state: { pending: r.pending } };
        continue;
      }
      if (profile.keywords.has(word)) {
        flush();
        tokens.push({ text: word, kind: "keyword" });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    // String literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      flush();
      const interp: Interp = ch === "`" ? "dollar" : "none";
      const r = scanString(line, i, i, interp);
      tokens.push(...r.tokens);
      i = r.end;
      if (r.pending) return { tokens, state: { pending: r.pending } };
      continue;
    }

    // Number (simple: digits, optional decimal/hex).
    if (DIGIT.test(ch)) {
      flush();
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j])) j += 1;
      tokens.push({ text: line.slice(i, j), kind: "number" });
      i = j;
      continue;
    }

    plain += ch;
    i += 1;
  }
  flush();
  return { tokens, state };
}

/** Tokenize a single line from a clean state (no multi-line carry-over). */
export function highlightLine(line: string, lang?: string): Token[] {
  return tokenizeLine(line, profileFor(lang), INITIAL_STATE).tokens;
}

/** Tokenize a whole code block, threading multi-line string state across lines
 * so triple-quoted Python strings and backtick template literals stay coloured
 * as one string rather than restarting the lexer on every line. */
export function highlightLines(lines: string[], lang?: string): Token[][] {
  const profile = profileFor(lang);
  let state = INITIAL_STATE;
  const out: Token[][] = [];
  for (const line of lines) {
    const r = tokenizeLine(line, profile, state);
    out.push(r.tokens);
    state = r.state;
  }
  return out;
}
