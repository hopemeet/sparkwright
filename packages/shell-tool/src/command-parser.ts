// AI maintenance note: A *tokenizer*, not a shell. The goal is to surface
// enough structure (argv head, presence of pipes/redirects/subshells) to feed
// the safety evaluator. Do NOT use this to drive execution — defer that to the
// execution environment which understands the real shell grammar.

/**
 * Coarse parse of a shell command line. Only structural flags and the leading
 * program name are exposed; full quoting semantics are intentionally out of
 * scope.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ParsedCommand {
  argv: string[];
  hasPipe: boolean;
  /** @reserved Public field consumed by safety evaluators and UIs. */
  hasRedirect: boolean;
  /** @reserved Public field consumed by safety evaluators and UIs. */
  hasSubshell: boolean;
  /**
   * True when the command contains a shell chain operator (`;`, `&&`, `||`,
   * `&`) outside quoted segments. Safety evaluators must treat chained
   * commands conservatively because only the leading program is classified.
   */
  hasChain: boolean;
  leadingProgram: string;
}

interface HereDocDelimiter {
  marker: string;
  stripTabs: boolean;
}

/**
 * Remove here-doc bodies while preserving the command lines that declare them.
 * The shell parser and safety classifier only need argv/operators; source text
 * inside a here-doc (for example a shebang) must not be treated as arguments.
 *
 * @public
 * @stability experimental v0.1
 */
export function stripHereDocBodies(command: string): string {
  const lines = command.split("\n");
  const pending: HereDocDelimiter[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0]!;
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.marker) {
        pending.shift();
      }
      kept.push("");
      continue;
    }

    kept.push(line);
    pending.push(...extractHereDocDelimiters(line));
  }

  return kept.join("\n");
}

function extractHereDocDelimiters(line: string): HereDocDelimiter[] {
  const delimiters: HereDocDelimiter[] = [];
  const pattern = /<<(?!<)(-)?\s*(?:"([^"]+)"|'([^']+)'|(\\?[^\s;&|()<>]+))/g;
  for (const match of line.matchAll(pattern)) {
    const rawMarker = match[2] ?? match[3] ?? match[4] ?? "";
    const marker = rawMarker.startsWith("\\") ? rawMarker.slice(1) : rawMarker;
    if (marker.length === 0) continue;
    delimiters.push({ marker, stripTabs: match[1] === "-" });
  }
  return delimiters;
}

/**
 * Tokenize a command line. Honors single/double quotes and backslash escapes
 * sufficient to keep operators inside quoted segments from being misread as
 * shell metacharacters.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseCommand(command: string): ParsedCommand {
  if (typeof command !== "string") {
    throw new Error("parseCommand requires a string.");
  }

  const tokens: string[] = [];
  let buffer = "";
  let quote: '"' | "'" | null = null;
  let hasPipe = false;
  let hasRedirect = false;
  let hasSubshell = false;
  let hasChain = false;

  const flushBuffer = () => {
    if (buffer.length > 0) {
      tokens.push(buffer);
      buffer = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        buffer += command[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      buffer += char;
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      buffer += command[index + 1];
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n") {
      flushBuffer();
      continue;
    }

    if (char === "|") {
      if (command[index + 1] === "|") {
        hasChain = true;
        flushBuffer();
        tokens.push("||");
        index += 1;
        continue;
      }
      hasPipe = true;
      flushBuffer();
      tokens.push("|");
      continue;
    }

    if (char === ";") {
      hasChain = true;
      flushBuffer();
      tokens.push(";");
      continue;
    }

    if (char === "&") {
      if (command[index + 1] === "&") {
        hasChain = true;
        flushBuffer();
        tokens.push("&&");
        index += 1;
        continue;
      }
      hasChain = true;
      flushBuffer();
      tokens.push("&");
      continue;
    }

    if (char === ">" || char === "<") {
      hasRedirect = true;
      flushBuffer();
      tokens.push(char);
      continue;
    }

    if (char === "(" || char === ")" || char === "`") {
      hasSubshell = true;
      flushBuffer();
      tokens.push(char);
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      hasSubshell = true;
      flushBuffer();
      tokens.push("$(");
      index += 1;
      continue;
    }

    buffer += char;
  }

  flushBuffer();

  const OPERATORS = new Set([
    "|",
    "||",
    ";",
    "&",
    "&&",
    ">",
    "<",
    "(",
    ")",
    "`",
    "$(",
  ]);
  const argv = tokens.filter((token) => !OPERATORS.has(token));
  const leadingProgram = argv[0] ?? "";

  return { argv, hasPipe, hasRedirect, hasSubshell, hasChain, leadingProgram };
}
