/**
 * Symbolic keybindings. Maps a "binding name" (semantic action, e.g.
 * `help.open`) to one or more key chords. The App-level hotkey loop asks
 * `matches(name, key, input)` instead of hard-coding chord literals, so users
 * can rebind via `keybindings` in the Sparkwright config.json.
 *
 * Chord syntax (case-insensitive, parts joined by `+`):
 *   "ctrl+k", "shift+tab", "alt+enter"
 *   special tokens: "esc", "enter", "tab", "backspace", "delete",
 *                   "up", "down", "left", "right", "pageup", "pagedown",
 *                   "home", "end", "space"
 *   single printable chars: "k", "?", "/"
 *
 * We deliberately keep this small — no leader-key sequences yet. If users
 * ask for chord chains ("ctrl+x q" → quit), we can extend `Chord` to a tuple.
 */

export type BindingName =
  | "help.open"
  | "cancel.run"
  | "quit.app"
  | "activity.open"
  | "events.open"
  | "details.toggle"
  | "transcript.page-up"
  | "transcript.page-down"
  | "transcript.top"
  | "transcript.bottom"
  | "history.search"
  | "cycle-permission-mode";

export interface Chord {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** Lowercased printable char OR a special token (see syntax above). */
  key: string;
}

export type Bindings = Record<BindingName, Chord[]>;

const SPECIAL_KEYS = new Set([
  "esc",
  "enter",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
  "space",
]);

export const DEFAULTS: Bindings = {
  "help.open": [parseChord("?")!],
  "cancel.run": [parseChord("esc")!],
  "quit.app": [parseChord("ctrl+c")!],
  "activity.open": [parseChord("ctrl+o")!],
  "events.open": [],
  // Toggle all user-facing transcript details. ctrl+t = "transcript".
  "details.toggle": [parseChord("ctrl+t")!],
  "transcript.page-up": [parseChord("pageup")!],
  "transcript.page-down": [parseChord("pagedown")!],
  // Ink 5 parses Home/End but drops their names from useInput's public Key.
  // InputBox restores Ctrl+Home/Ctrl+End from the raw terminal sequence before
  // routing them through this same binding table.
  "transcript.top": [parseChord("ctrl+home")!],
  "transcript.bottom": [parseChord("ctrl+end")!],
  // history.search is handled inside InputBox (ctrl+r is bash-standard);
  // exposed here so /help and /config can show + override it.
  "history.search": [parseChord("ctrl+r")!],
  "cycle-permission-mode": [parseChord("shift+tab")!],
};

/**
 * Parse one chord string. Returns null if the input is unparseable so the
 * config validator can flag it. Empty string parses to null (treated as "no
 * binding" — callers strip these so users can intentionally disable a default).
 */
export function parseChord(input: string): Chord | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  const parts = raw
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  if (parts.length === 0) return null;
  let ctrl = false;
  let shift = false;
  let meta = false;
  let key: string | null = null;
  for (const p of parts) {
    if (p === "ctrl" || p === "control") ctrl = true;
    else if (p === "shift") shift = true;
    else if (p === "alt" || p === "meta" || p === "super" || p === "cmd")
      meta = true;
    else if (key !== null)
      return null; // two non-modifier parts → invalid
    else key = p;
  }
  if (!key) return null;
  if (key.length > 1 && !SPECIAL_KEYS.has(key)) return null;
  return { ctrl, shift, meta, key };
}

export function parseChords(input: string | string[]): Chord[] {
  const arr = Array.isArray(input) ? input : [input];
  const out: Chord[] = [];
  for (const s of arr) {
    const c = parseChord(s);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Match a chord against an Ink `useInput` event. Ink reports special keys via
 * the `key` flag object and printable chars in `input`. We unify them here.
 */
export function chordMatches(
  chord: Chord,
  inkKey: {
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    escape?: boolean;
    return?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
  },
  inkInput: string,
): boolean {
  if (chord.ctrl && chord.key === "c" && ctrlCPressCount(inkInput) > 0) {
    return !chord.meta;
  }
  // Most terminals encode Ctrl+I as the Tab control byte. Ink therefore may
  // report Ctrl+I as `key.tab` instead of `{ ctrl: true, input: "i" }`.
  if (
    chord.ctrl &&
    !chord.shift &&
    !chord.meta &&
    chord.key === "i" &&
    (inkInput === "\t" || inkKey.tab)
  ) {
    return true;
  }
  if (!!chord.ctrl !== !!inkKey.ctrl) return false;
  if (!!chord.meta !== !!inkKey.meta) return false;
  // Ink's `shift` flag isn't always reliable for printable chars (user just
  // types uppercase) — we only enforce shift for special keys.
  if (chord.key.length === 1) {
    if (chord.shift && !inkKey.shift) return false;
    return inkInput.toLowerCase() === chord.key;
  }
  switch (chord.key) {
    case "esc":
      return !!inkKey.escape;
    case "enter":
      return !!inkKey.return;
    case "tab":
      return !!inkKey.tab && (!chord.shift || !!inkKey.shift);
    case "backspace":
      return !!inkKey.backspace;
    case "delete":
      return !!inkKey.delete;
    case "up":
      return !!inkKey.upArrow;
    case "down":
      return !!inkKey.downArrow;
    case "left":
      return !!inkKey.leftArrow;
    case "right":
      return !!inkKey.rightArrow;
    case "pageup":
      return !!inkKey.pageUp;
    case "pagedown":
      return !!inkKey.pageDown;
    case "home":
      return !!inkKey.home;
    case "end":
      return !!inkKey.end;
    case "space":
      return inkInput === " ";
    default:
      return false;
  }
}

export function isPlainPrintableChord(chord: Chord): boolean {
  return (
    !chord.ctrl &&
    !chord.meta &&
    !chord.shift &&
    (chord.key.length === 1 || chord.key === "space")
  );
}

export function isPlainEscapeChord(chord: Chord): boolean {
  return !chord.ctrl && !chord.meta && !chord.shift && chord.key === "esc";
}

export function shouldDeferPrintableChordToInput(
  chords: readonly Chord[],
  inkKey: Parameters<typeof chordMatches>[1],
  inkInput: string,
  draft: string,
): boolean {
  if (draft.length === 0) return false;
  return chords.some(
    (chord) =>
      isPlainPrintableChord(chord) && chordMatches(chord, inkKey, inkInput),
  );
}

export function ctrlCPressCount(inkInput: string): number {
  let count = 0;
  for (const char of inkInput) {
    if (char === "\x03") count += 1;
  }
  return count;
}

const CTRL_HOME_SEQUENCES = new Set(["\x1b[1;5H", "\x1b[1;5~", "\x1b[7^"]);
const CTRL_END_SEQUENCES = new Set(["\x1b[1;5F", "\x1b[4;5~", "\x1b[8^"]);

/**
 * Ink 5's parser recognises Home/End but its public Key omits both flags.
 * Recover only the explicit Ctrl variants from raw terminal data; plain
 * Home/End remain available to the composer/terminal rather than becoming an
 * accidental transcript shortcut.
 */
export function ctrlTranscriptBoundaryKey(
  sequence: string,
): "home" | "end" | null {
  if (CTRL_HOME_SEQUENCES.has(sequence)) return "home";
  if (CTRL_END_SEQUENCES.has(sequence)) return "end";
  return null;
}

/** Pretty-print a chord for help panels. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.meta) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

export function formatBinding(chords: Chord[]): string {
  return chords.map(formatChord).join(", ");
}

/**
 * Merge user-supplied bindings on top of DEFAULTS. Unknown names are
 * reported (returned errors); empty arrays/strings *clear* the default
 * (so users can intentionally unbind something).
 */
export function mergeBindings(
  user: Record<string, string | string[] | null> | undefined,
): { bindings: Bindings; errors: { name: string; message: string }[] } {
  const bindings: Bindings = JSON.parse(JSON.stringify(DEFAULTS)) as Bindings;
  const errors: { name: string; message: string }[] = [];
  if (!user) return { bindings, errors };
  const known = new Set<string>(Object.keys(DEFAULTS));
  const normalizedUser = { ...user };
  // Compatibility bridge for configs written before Ctrl+T became a unified
  // details mode. An explicit canonical binding always wins.
  if (
    !Object.prototype.hasOwnProperty.call(normalizedUser, "details.toggle") &&
    Object.prototype.hasOwnProperty.call(normalizedUser, "todo.toggle")
  ) {
    normalizedUser["details.toggle"] = normalizedUser["todo.toggle"];
  }
  delete normalizedUser["todo.toggle"];
  for (const [name, value] of Object.entries(normalizedUser)) {
    if (!known.has(name)) {
      errors.push({
        name,
        message: `unknown binding (allowed: ${[...known].join(", ")})`,
      });
      continue;
    }
    if (
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      bindings[name as BindingName] = [];
      continue;
    }
    const parsed = parseChords(value);
    if (parsed.length === 0) {
      errors.push({
        name,
        message: `no valid chords in ${JSON.stringify(value)}`,
      });
      continue;
    }
    bindings[name as BindingName] = parsed;
  }
  return { bindings, errors };
}
