import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { CommandRegistry, Command } from "../lib/commands.js";
import {
  appendHistory,
  loadHistory,
  type HistoryEntry,
} from "../lib/history.js";
import { FileIndex, type IndexedFile } from "../lib/files.js";
import { loadFrecency, type Frecency } from "../lib/frecency.js";
import { clearDraftOnSubmit, saveDraft, type StashFile } from "../lib/stash.js";
import {
  graphemeAt,
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
} from "../lib/graphemes.js";

/**
 * Goal input with three "intent" surfaces sharing one editor:
 *  - SLASH (value starts with "/"): registry-based command picker; Tab
 *    completes; Enter dispatches via onCommand.
 *  - MENTION (`@…` token at cursor): workspace file picker; Tab/Enter
 *    replaces the @-token with the chosen path.
 *  - NORMAL: ↑/↓ recalls history; Enter submits; large pastes turn into
 *    [Pasted #N · M lines] placeholders that re-expand on submit.
 *
 * The cursor is a numeric index into `value`. We render the char under the
 * cursor as inverse text so users have a visible caret.
 *
 * Paste detection is heuristic (single useInput event with >=
 * PASTE_THRESHOLD chars). We also enable bracketed paste on mount so
 * terminals that support it deliver pastes as a single chunk reliably.
 */

interface PastePart {
  id: number;
  text: string;
  lines: number;
}

const PASTE_THRESHOLD = 50;
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const PASTE_PLACEHOLDER_RE = /\[Pasted #(\d+) · \d+ lines?\]/g;

export interface InputBoxHandle {
  /** Imperative: replace the current value (used by the stash picker). */
  setValue: (text: string) => void;
}

export function InputBox(props: {
  disabled: boolean;
  placeholder?: string;
  workspaceRoot: string;
  registry: CommandRegistry;
  onSubmit: (value: string) => void;
  onCommand: (cmd: Command, rest: string) => void;
  /**
   * Pressed Esc with nothing else to dismiss (no dropdown / overlay open).
   * The parent uses this to cancel an in-flight run. Wired here — rather than
   * in the App-level global hotkey loop — because that loop lives in an inline
   * component that React remounts on every render, so its `useInput` churns
   * and drops the lone Esc during streaming. InputBox is a stable component, so
   * its handler reliably receives the key.
   */
  onEscape?: () => void;
  /** Stash snapshot bridge — parent owns the latest StashFile. */
  stashRef: { current: StashFile };
  onStashChange: (next: StashFile) => void;
  /** Imperative handle for the parent (used to inject restored drafts). */
  handleRef?: React.MutableRefObject<InputBoxHandle | null>;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pastes, setPastes] = useState<Map<number, PastePart>>(new Map());
  const pasteIdRef = useRef(1);
  const { stdout } = useStdout();
  // ctrl+r reverse-search overlay state — when not null, captures input.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchCursor, setSearchCursor] = useState(0);

  // Lazy file index — only constructed when needed.
  const fileIndex = useMemo(
    () => new FileIndex(props.workspaceRoot),
    [props.workspaceRoot],
  );
  const frecencyRef = useRef<Frecency | null>(null);
  const [frecencyScores, setFrecencyScores] = useState<Map<string, number>>(
    new Map(),
  );

  // Enable bracketed paste on mount; disable on unmount so we don't leave the
  // terminal in a weird state if the app exits.
  useEffect(() => {
    if (stdout?.isTTY) stdout.write(BRACKETED_PASTE_ON);
    return () => {
      if (stdout?.isTTY) stdout.write(BRACKETED_PASTE_OFF);
    };
  }, [stdout]);

  useEffect(() => {
    void loadHistory(props.workspaceRoot).then(setHistory);
    // On mount, if the stash has a current draft and the input is empty,
    // restore it. We don't auto-restore over an existing user-typed value.
    const current = props.stashRef.current.current;
    if (current && current.text.length > 0 && value.length === 0) {
      setValue(current.text);
      setCursor(current.text.length);
    }
  }, [props.workspaceRoot]);

  // Expose imperative setValue so the parent's /stash dialog can inject text.
  useEffect(() => {
    if (!props.handleRef) return;
    props.handleRef.current = {
      setValue: (text: string) => {
        setValue(text);
        setCursor(text.length);
        setHistoryIdx(null);
        setSugCursor(0);
      },
    };
    return () => {
      if (props.handleRef) props.handleRef.current = null;
    };
  }, [props.handleRef]);

  // Debounced stash persistence as the user types.
  useEffect(() => {
    if (props.disabled) return;
    const id = setTimeout(() => {
      void saveDraft(props.workspaceRoot, value, props.stashRef.current).then(
        props.onStashChange,
      );
    }, 600);
    return () => clearTimeout(id);
  }, [value, props.workspaceRoot, props.disabled]);

  // Detect the three modes from the current value/cursor. Slash takes
  // precedence over mention because "/foo @bar" should still be a command.
  const slash = useMemo(() => detectSlash(value), [value]);
  const mention = useMemo(
    () => (slash ? null : detectMention(value, cursor)),
    [value, cursor, slash],
  );

  // Trigger file indexing + frecency load the first time mention activates.
  useEffect(() => {
    if (!mention) return;
    void fileIndex.ensure();
    if (!frecencyRef.current) {
      void loadFrecency(props.workspaceRoot).then((f) => {
        frecencyRef.current = f;
        setFrecencyScores(f.scores());
      });
    }
  }, [mention !== null, fileIndex, props.workspaceRoot]);

  const slashSuggestions = useMemo(
    () => (slash ? props.registry.search(slash.query) : []),
    [slash, props.registry],
  );
  const mentionSuggestions = useMemo(
    () => (mention ? fileIndex.filter(mention.query, 10, frecencyScores) : []),
    // Re-filter when index size changes (after ensure resolves) or frecency loads.
    [mention, fileIndex.size(), frecencyScores],
  );

  const [sugCursor, setSugCursor] = useState(0);
  const activeList: ReadonlyArray<unknown> = slash
    ? slashSuggestions
    : mentionSuggestions;
  const safeSugCursor = Math.min(sugCursor, Math.max(0, activeList.length - 1));

  // Inline "ghost" completion: the remainder of the highlighted slash command,
  // shown dimmed after the caret. Only when the caret is at the end and the
  // command is a true prefix of what's typed — so it reads as a suggestion you
  // can accept with → (or Tab) rather than a guess. Mentions use fuzzy
  // matching, so a prefix ghost there would mislead; we keep ghosting to slash.
  const ghost = useMemo(() => {
    if (!slash || slashSuggestions.length === 0) return "";
    if (cursor !== value.length) return "";
    const typed = value.slice(1); // drop leading "/"
    const name = slashSuggestions[safeSugCursor]?.name ?? "";
    if (
      name.length > typed.length &&
      name.toLowerCase().startsWith(typed.toLowerCase())
    ) {
      return name.slice(typed.length);
    }
    return "";
  }, [slash, slashSuggestions, safeSugCursor, cursor, value]);

  function update(
    next: string,
    nextCursor?: number,
    nextPastes?: Map<number, PastePart>,
  ): void {
    setValue(next);
    setCursor(nextCursor ?? next.length);
    setHistoryIdx(null);
    setSugCursor(0);
    if (nextPastes) setPastes(nextPastes);
  }

  /**
   * Move the caret up/down one visual line in a multi-line draft, preserving
   * the column (clamped to the target line's length). No-op past the first /
   * last line.
   */
  function moveCursorVertical(dir: -1 | 1): void {
    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
    const col = cursor - lineStart;
    if (dir === -1) {
      if (lineStart === 0) return; // already on the first line
      const prevLineEnd = lineStart - 1; // the '\n' before this line
      const prevLineStart = value.lastIndexOf("\n", prevLineEnd - 1) + 1;
      const prevLineLen = prevLineEnd - prevLineStart;
      setCursor(prevLineStart + Math.min(col, prevLineLen));
    } else {
      const nlIdx = value.indexOf("\n", cursor);
      if (nlIdx === -1) return; // already on the last line
      const nextLineStart = nlIdx + 1;
      let nextLineEnd = value.indexOf("\n", nextLineStart);
      if (nextLineEnd === -1) nextLineEnd = value.length;
      const nextLineLen = nextLineEnd - nextLineStart;
      setCursor(nextLineStart + Math.min(col, nextLineLen));
    }
  }

  function recallHistory(direction: -1 | 1): void {
    if (history.length === 0) return;
    if (historyIdx === null) {
      if (direction === 1) return;
      setDraft(value);
      const idx = history.length - 1;
      setHistoryIdx(idx);
      setValue(history[idx].text);
      setCursor(history[idx].text.length);
      return;
    }
    const next = historyIdx + direction;
    if (next < 0) {
      setHistoryIdx(0);
      return;
    }
    if (next >= history.length) {
      setHistoryIdx(null);
      setValue(draft);
      setCursor(draft.length);
      return;
    }
    setHistoryIdx(next);
    setValue(history[next].text);
    setCursor(history[next].text.length);
  }

  function applySlashPick(cmd: Command): void {
    // Recover the rest-of-line (everything after the command name) so arg-aware
    // commands like `/commit fix the bug` can fill `$ARGUMENTS`. The query is
    // the value after the leading slash; the first token is the command name.
    const query = detectSlash(value)?.query ?? "";
    const space = query.indexOf(" ");
    const rest = space === -1 ? "" : query.slice(space + 1).trim();
    props.onCommand(cmd, rest);
    setValue("");
    setCursor(0);
  }

  function applyMentionPick(file: IndexedFile): void {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(cursor);
    // Quote paths with whitespace to keep them parseable downstream.
    const token = /\s/.test(file.path) ? `"${file.path}"` : file.path;
    const inserted = "@" + token + " ";
    update(before + inserted + after, before.length + inserted.length);
    // Record the pick for frecency ranking next time.
    void frecencyRef.current?.bump(file.path).then(() => {
      if (frecencyRef.current) setFrecencyScores(frecencyRef.current.scores());
    });
  }

  function expandPastes(text: string): string {
    return text.replace(PASTE_PLACEHOLDER_RE, (m, id) => {
      const p = pastes.get(Number(id));
      return p ? p.text : m;
    });
  }

  // History reverse-search: scan newest-first for entries containing the query.
  const searchMatches = useMemo(() => {
    if (searchQuery === null) return [];
    const q = searchQuery.toLowerCase();
    const out: HistoryEntry[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (!q || e.text.toLowerCase().includes(q)) out.push(e);
      if (out.length >= 8) break;
    }
    return out;
  }, [history, searchQuery]);
  const safeSearchCursor = Math.min(
    searchCursor,
    Math.max(0, searchMatches.length - 1),
  );

  useInput((input, key) => {
    if (props.disabled) return;

    // Terminal focus reporting (DECSET 1004, enabled by AttentionManager) emits
    // CSI I on focus and CSI O on blur. Ink doesn't recognise them as keys and,
    // after stripping the leading ESC, hands them to us as literal "[I" / "[O"
    // — which would otherwise be typed into the goal. Swallow them. (Switching
    // macOS spaces/apps is what makes the terminal fire these.)
    if (input === "[I" || input === "[O") return;

    // --- ctrl+r reverse-search overlay owns input while active ------------
    if (searchQuery !== null) {
      if (key.escape) {
        setSearchQuery(null);
        return;
      }
      if (key.return) {
        const pick = searchMatches[safeSearchCursor];
        if (pick) {
          setValue(pick.text);
          setCursor(pick.text.length);
        }
        setSearchQuery(null);
        return;
      }
      if (key.upArrow) {
        setSearchCursor((c) => Math.min(searchMatches.length - 1, c + 1));
        return;
      }
      if (key.downArrow) {
        setSearchCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => (q ? q.slice(0, -1) : ""));
        setSearchCursor(0);
        return;
      }
      // Ctrl+r again advances to next match without dismissing.
      if (key.ctrl && input === "r") {
        setSearchCursor((c) => Math.min(searchMatches.length - 1, c + 1));
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      if (input && input.length > 0) {
        setSearchQuery((q) => (q ?? "") + input);
        setSearchCursor(0);
      }
      return;
    }

    // Ctrl+r enters reverse-search mode.
    if (key.ctrl && input === "r" && history.length > 0) {
      setSearchQuery("");
      setSearchCursor(0);
      return;
    }

    // --- dropdown navigation takes priority when a suggestion list is open --
    if (slash && slashSuggestions.length > 0) {
      if (key.downArrow) {
        setSugCursor((c) => Math.min(slashSuggestions.length - 1, c + 1));
        return;
      }
      if (key.upArrow) {
        setSugCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.tab) {
        const pick = slashSuggestions[safeSugCursor];
        if (pick) update("/" + pick.name);
        return;
      }
    } else if (mention) {
      if (key.downArrow && mentionSuggestions.length > 0) {
        setSugCursor((c) => Math.min(mentionSuggestions.length - 1, c + 1));
        return;
      }
      if (key.upArrow && mentionSuggestions.length > 0) {
        setSugCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.tab && mentionSuggestions.length > 0) {
        const pick = mentionSuggestions[safeSugCursor];
        if (pick) applyMentionPick(pick);
        return;
      }
      if (key.escape) {
        // Cancel mention by inserting a space — breaks the @ token.
        // Conservative: do nothing, let user keep typing or backspace.
        return;
      }
    } else {
      // In a multi-line draft, ↑/↓ move the caret between visual lines;
      // history recall only kicks in for a single-line draft (so it doesn't
      // fight vertical editing).
      if (key.upArrow) {
        if (value.includes("\n")) {
          moveCursorVertical(-1);
          return;
        }
        recallHistory(-1);
        return;
      }
      if (key.downArrow) {
        if (value.includes("\n")) {
          moveCursorVertical(1);
          return;
        }
        recallHistory(1);
        return;
      }
    }

    // --- submission --------------------------------------------------------
    if (key.return) {
      // Multi-line editing: Alt/Shift+Enter — or a line ending in a trailing
      // backslash — inserts a newline instead of submitting. Plain Enter still
      // submits. Slash commands stay single-line.
      if (!slash) {
        if (key.meta || key.shift) {
          const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
          update(next, cursor + 1);
          return;
        }
        if (cursor > 0 && value[cursor - 1] === "\\") {
          const next = value.slice(0, cursor - 1) + "\n" + value.slice(cursor);
          update(next, cursor);
          return;
        }
      }
      const trimmed = value.trim();
      if (!trimmed) return;
      if (slash && slashSuggestions.length > 0) {
        const pick = slashSuggestions[safeSugCursor];
        if (pick) {
          applySlashPick(pick);
          return;
        }
      }
      if (mention && mentionSuggestions.length > 0) {
        // Treat enter in mention as "pick the file" — feels natural and
        // matches the @-completion expectation.
        const pick = mentionSuggestions[safeSugCursor];
        if (pick) {
          applyMentionPick(pick);
          return;
        }
      }
      if (slash) {
        const parsed = parseSlashCommand(trimmed);
        const cmd = props.registry.resolve(parsed.name);
        if (cmd) {
          props.onCommand(cmd, parsed.rest);
          setValue("");
          setCursor(0);
          return;
        }
      }
      const expanded = expandPastes(trimmed);
      props.onSubmit(expanded);
      void appendHistory(props.workspaceRoot, expanded, history).then(
        setHistory,
      );
      void clearDraftOnSubmit(props.workspaceRoot, props.stashRef.current).then(
        props.onStashChange,
      );
      setValue("");
      setCursor(0);
      setHistoryIdx(null);
      setDraft("");
      setPastes(new Map());
      return;
    }

    // --- cursor / editing -------------------------------------------------
    // Word-wise movement: Alt/Ctrl + ←/→ (check before the plain arrows so the
    // modifier isn't swallowed).
    if ((key.meta || key.ctrl) && key.leftArrow) {
      setCursor((c) => prevWordBoundary(value, c));
      return;
    }
    if ((key.meta || key.ctrl) && key.rightArrow) {
      setCursor((c) => nextWordBoundary(value, c));
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => prevGraphemeBoundary(value, c));
      return;
    }
    if (key.rightArrow) {
      // At the end of a slash command with a ghost suggestion, → accepts it.
      if (ghost && cursor === value.length) {
        update(value + ghost);
        return;
      }
      setCursor((c) => nextGraphemeBoundary(value, c));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      // If we're deleting through a placeholder, drop the matching paste
      // entry so memory doesn't leak across the session.
      const placeholderHit = matchPlaceholderAt(value, cursor - 1);
      let nextPastes = pastes;
      // Default: delete one grapheme cluster before the caret (so an emoji /
      // combining sequence is removed whole, not one code unit at a time).
      let removeFrom = prevGraphemeBoundary(value, cursor);
      let removeLen = cursor - removeFrom;
      if (placeholderHit) {
        nextPastes = new Map(pastes);
        nextPastes.delete(placeholderHit.id);
        removeFrom = placeholderHit.start;
        removeLen = placeholderHit.end - placeholderHit.start;
      }
      const next =
        value.slice(0, removeFrom) + value.slice(removeFrom + removeLen);
      update(next, removeFrom, nextPastes);
      return;
    }
    if (key.ctrl && input === "u") {
      update("", 0, new Map());
      return;
    }
    if (key.ctrl && input === "w") {
      const left = value.slice(0, cursor);
      const right = value.slice(cursor);
      const trimmed = left.replace(/\S+\s*$/, "");
      update(trimmed + right, trimmed.length);
      return;
    }
    if (key.ctrl && input === "a") {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(value.length);
      return;
    }
    // Alt+d: delete forward to the next word boundary.
    if (key.meta && input === "d") {
      const end = nextWordBoundary(value, cursor);
      if (end > cursor)
        update(value.slice(0, cursor) + value.slice(end), cursor);
      return;
    }
    if (key.escape) {
      // Nothing else claimed Esc (no search/mention/slash overlay consumed it
      // above), so surface it to the parent — used to cancel an in-flight run.
      props.onEscape?.();
      return;
    }
    if (key.tab || key.ctrl || key.meta) return;

    if (!input || input.length === 0) return;

    // --- paste detection --------------------------------------------------
    const stripped = stripBracketedPaste(input);
    const isPaste =
      stripped.wasBracketed ||
      stripped.text.length >= PASTE_THRESHOLD ||
      stripped.text.includes("\n");
    if (isPaste && stripped.text.length > 0) {
      const id = pasteIdRef.current++;
      const lines = stripped.text.split("\n").length;
      const placeholder = `[Pasted #${id} · ${lines} line${lines === 1 ? "" : "s"}]`;
      const next = value.slice(0, cursor) + placeholder + value.slice(cursor);
      const nextPastes = new Map(pastes);
      nextPastes.set(id, { id, text: stripped.text, lines });
      update(next, cursor + placeholder.length, nextPastes);
      return;
    }

    const next = value.slice(0, cursor) + input + value.slice(cursor);
    update(next, cursor + input.length);
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        {value.length === 0 ? (
          <Box>
            <Text color={props.disabled ? "gray" : "cyan"}>{"› "}</Text>
            {props.disabled ? null : <Text inverse> </Text>}
            <Text dimColor>{props.placeholder ?? ""}</Text>
          </Box>
        ) : (
          <RenderedInput
            value={value}
            cursor={cursor}
            slash={!!slash}
            disabled={props.disabled}
            ghost={ghost}
          />
        )}
      </Box>
      {searchQuery !== null ? (
        <ReverseSearchOverlay
          query={searchQuery}
          matches={searchMatches}
          cursor={safeSearchCursor}
        />
      ) : null}
      {searchQuery === null && slash && slashSuggestions.length > 0 ? (
        <SlashDropdown suggestions={slashSuggestions} cursor={safeSugCursor} />
      ) : null}
      {mention && mentionSuggestions.length > 0 ? (
        <MentionDropdown
          suggestions={mentionSuggestions}
          query={mention.query}
          cursor={safeSugCursor}
          indexSize={fileIndex.size()}
        />
      ) : mention ? (
        <Box paddingX={1}>
          <Text dimColor>
            (no files match "@{mention.query}" — index has {fileIndex.size()})
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Render a (possibly multi-line) draft with a visible inverse caret and
 * per-segment coloring: placeholders dim, slash mode magenta, @-tokens cyan.
 * Each line gets its own row; the first row is prefixed with "› ", wrapped
 * continuation rows with two spaces, so the caret stays aligned across lines.
 */
function RenderedInput(props: {
  value: string;
  cursor: number;
  slash: boolean;
  disabled: boolean;
  /** Dimmed inline completion appended after the last line (slash mode). */
  ghost?: string;
}): React.ReactElement {
  const { value, cursor } = props;
  const lines = value.split("\n");

  // Locate the caret's (line, column). `column` is a code-unit offset into the
  // line; movement keeps the global cursor on grapheme boundaries, so the
  // column lands on one too.
  let acc = 0;
  let caretLine = lines.length - 1;
  let caretCol = lines[lines.length - 1]?.length ?? 0;
  for (let li = 0; li < lines.length; li++) {
    const len = lines[li].length;
    if (cursor <= acc + len) {
      caretLine = li;
      caretCol = cursor - acc;
      break;
    }
    acc += len + 1; // + the newline
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, li) => (
        <Box key={li}>
          <Text color={props.disabled ? "gray" : "cyan"}>
            {li === 0 ? "› " : "  "}
          </Text>
          <LineView
            line={line}
            slash={props.slash && li === 0}
            caretCol={!props.disabled && li === caretLine ? caretCol : null}
          />
          {props.ghost && li === lines.length - 1 ? (
            <Text dimColor>{props.ghost}</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

/** One transcript line of the draft, with an optional inverse caret. */
function LineView(props: {
  line: string;
  slash: boolean;
  /** Code-unit column of the caret on this line, or null if not the caret line. */
  caretCol: number | null;
}): React.ReactElement {
  const segments = colorizeSegments(props.line, props.slash);
  if (props.caretCol === null) {
    // Render a single space for an empty line so the row keeps its height.
    if (segments.length === 0) return <Text> </Text>;
    return (
      <>
        {segments.map((seg, i) => (
          <Segment key={i} seg={seg} />
        ))}
      </>
    );
  }
  const caretCol = props.caretCol;
  const out: React.ReactElement[] = [];
  let consumed = 0;
  let placed = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = consumed;
    const end = consumed + seg.text.length;
    if (!placed && caretCol >= start && caretCol < end) {
      const local = caretCol - start;
      const at = graphemeAt(seg.text, local);
      const before = seg.text.slice(0, local);
      const after = seg.text.slice(local + at.length);
      out.push(
        <Segment key={`${i}a`} seg={{ ...seg, text: before }} />,
        <Text key={`${i}c`} inverse>
          {at}
        </Text>,
        <Segment key={`${i}b`} seg={{ ...seg, text: after }} />,
      );
      placed = true;
    } else {
      out.push(<Segment key={i} seg={seg} />);
    }
    consumed = end;
  }
  // Caret at end of line (or empty line): render a trailing inverse space.
  if (!placed) {
    out.push(
      <Text key="caret" inverse>
        {" "}
      </Text>,
    );
  }
  return <>{out}</>;
}

interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
}

function colorizeSegments(value: string, slash: boolean): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  if (slash) {
    return [{ text: value, color: "magenta" }];
  }
  // Walk value, emitting [normal][placeholder][normal][mention][normal] etc.
  const pattern = /(\[Pasted #\d+ · \d+ lines?\])|(@(?:"[^"]+"|[^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: value.slice(cursor, match.index) });
    }
    if (match[1]) {
      segments.push({ text: match[1], dim: true });
    } else if (match[2]) {
      segments.push({ text: match[2], color: "cyan" });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor) });
  }
  return segments;
}

function Segment(props: { seg: Segment }): React.ReactElement | null {
  if (!props.seg.text) return null;
  return (
    <Text color={props.seg.color} dimColor={props.seg.dim}>
      {props.seg.text}
    </Text>
  );
}

function SlashDropdown(props: {
  suggestions: Command[];
  cursor: number;
}): React.ReactElement {
  const windowSize = 6;
  const { start, visible } = suggestionWindow(
    props.suggestions,
    props.cursor,
    windowSize,
  );
  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((cmd, i) => {
        const selected = start + i === props.cursor;
        return (
          <Box key={cmd.name}>
            <Text color={selected ? "magenta" : undefined}>
              {selected ? "▸ " : "  "}
            </Text>
            <Text color={selected ? "magenta" : "white"} bold={selected}>
              /{cmd.name}
            </Text>
            <Text dimColor> {cmd.title}</Text>
          </Box>
        );
      })}
      {props.suggestions.length > windowSize ? (
        <Text dimColor>
          {start + 1}-{Math.min(props.suggestions.length, start + windowSize)}{" "}
          of {props.suggestions.length}
        </Text>
      ) : null}
      <Text dimColor>↑/↓ select · tab/→ complete · enter run</Text>
    </Box>
  );
}

export function suggestionWindow<T>(
  items: readonly T[],
  cursor: number,
  windowSize: number,
): { start: number; visible: readonly T[] } {
  const size = Math.max(1, windowSize);
  const safeCursor = Math.max(
    0,
    Math.min(cursor, Math.max(0, items.length - 1)),
  );
  const start = Math.max(
    0,
    Math.min(items.length - size, safeCursor - Math.floor(size / 2)),
  );
  return { start, visible: items.slice(start, start + size) };
}

function ReverseSearchOverlay(props: {
  query: string;
  matches: HistoryEntry[];
  cursor: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="yellow" bold>
          (reverse-i-search)
        </Text>
        <Text>{"`"}</Text>
        <Text color="yellow">{props.query}</Text>
        <Text>{"': "}</Text>
        <Text>{props.matches[0]?.text.slice(0, 80) ?? "(no match)"}</Text>
      </Box>
      {props.matches.slice(0, 6).map((entry, i) => {
        const selected = i === props.cursor;
        return (
          <Box key={`${entry.ts}-${i}`}>
            <Text color={selected ? "yellow" : undefined}>
              {selected ? "▸ " : "  "}
            </Text>
            <Text dimColor={!selected} color={selected ? "yellow" : undefined}>
              {entry.text.replace(/\n/g, " ").slice(0, 90)}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>
        type to filter · ↑/↓ select · ctrl+r next · enter use · esc cancel
      </Text>
    </Box>
  );
}

function MentionDropdown(props: {
  suggestions: IndexedFile[];
  query: string;
  cursor: number;
  indexSize: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {props.suggestions.map((f, i) => {
        const selected = i === props.cursor;
        return (
          <Box key={f.path}>
            <Text color={selected ? "cyan" : undefined}>
              {selected ? "▸ " : "  "}
            </Text>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {f.path}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>
        @{props.query} · ↑/↓ select · tab/enter insert · {props.indexSize} files
        indexed
      </Text>
    </Box>
  );
}

// ---- helpers ------------------------------------------------------------

function detectSlash(value: string): { query: string } | null {
  return value.startsWith("/") ? { query: value.slice(1) } : null;
}

function parseSlashCommand(value: string): { name: string; rest: string } {
  const query = value.trim().replace(/^\/+/u, "");
  const space = query.search(/\s/u);
  if (space === -1) return { name: query, rest: "" };
  return {
    name: query.slice(0, space),
    rest: query.slice(space + 1).trim(),
  };
}

/**
 * Returns `{ start, query }` if there's an `@token` ending at `cursor`
 * (i.e. the user is mid-mention). The token may not contain whitespace.
 * Empty query (just typed `@`) is treated as active.
 */
function detectMention(
  value: string,
  cursor: number,
): { start: number; query: string } | null {
  if (cursor === 0) return null;
  // Walk backward from cursor-1 looking for '@' with whitespace/begin before it.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      if (i > 0 && !/\s/.test(value[i - 1])) return null;
      return { start: i, query: value.slice(i + 1, cursor) };
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/**
 * Strip CSI 200~ / 201~ bracketed-paste markers if present. Returns the inner
 * text plus a flag so the caller can force paste-treatment even when the
 * stripped text is short.
 *
 * Ink parses the leading ESC (0x1b) of CSI sequences itself, so by the time
 * the marker reaches us the ESC may already be gone — i.e. we can see either
 * the full "\x1b[200~" or a bare "[200~". We match both; otherwise the literal
 * "[200~" leaks into the goal text (it shipped to the model that way before).
 */
// eslint-disable-next-line no-control-regex
const PASTE_START_RE = new RegExp("\\x1b?\\[200~");
// eslint-disable-next-line no-control-regex
const PASTE_END_RE = new RegExp("\\x1b?\\[201~");
export function stripBracketedPaste(input: string): {
  text: string;
  wasBracketed: boolean;
} {
  const start = PASTE_START_RE.exec(input);
  if (!start) {
    // A lone end marker can arrive in its own event (paste tail). Drop it so
    // it never reaches the buffer, but don't treat this as a paste.
    return { text: input.replace(PASTE_END_RE, ""), wasBracketed: false };
  }
  const after = input.slice(start.index + start[0].length);
  const end = PASTE_END_RE.exec(after);
  const text = end ? after.slice(0, end.index) : after;
  return { text, wasBracketed: true };
}

/**
 * Find a `[Pasted #N · M lines]` placeholder that contains the given index.
 * Returns its bounds + id, or null.
 */
function matchPlaceholderAt(
  value: string,
  index: number,
): { start: number; end: number; id: number } | null {
  PASTE_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASTE_PLACEHOLDER_RE.exec(value)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (index >= start && index < end) {
      return { start, end, id: Number(m[1]) };
    }
  }
  return null;
}
