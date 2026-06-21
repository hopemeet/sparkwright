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
  | "events.open"
  | "todo.toggle"
  | "history.search";

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
  "events.open": [parseChord("ctrl+o")!],
  // Expand/collapse the todo band's completed items. ctrl+t = "todo".
  "todo.toggle": [parseChord("ctrl+t")!],
  // history.search is handled inside InputBox (ctrl+r is bash-standard);
  // exposed here so /help and /config can show + override it.
  "history.search": [parseChord("ctrl+r")!],
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
  },
  inkInput: string,
): boolean {
  if (chord.ctrl && chord.key === "c" && ctrlCPressCount(inkInput) > 0) {
    return !chord.meta;
  }
  if (!!chord.ctrl !== !!inkKey.ctrl) return false;
  if (!!chord.meta !== !!inkKey.meta) return false;
  // Ink's `shift` flag isn't always reliable for printable chars (user just
  // types uppercase) — we only enforce shift for special keys.
  if (chord.key.length === 1) {
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
    case "space":
      return inkInput === " ";
    default:
      return false;
  }
}

export function ctrlCPressCount(inkInput: string): number {
  let count = 0;
  for (const char of inkInput) {
    if (char === "\x03") count += 1;
  }
  return count;
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
  for (const [name, value] of Object.entries(user)) {
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
