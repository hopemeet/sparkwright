/**
 * Semantic color palette. Components use `useTheme()` to look up colors by
 * intent (`theme.accent`, `theme.success`, ...) instead of naming ANSI colors
 * directly, so swapping the palette repaints the whole TUI without touching
 * a single component.
 *
 * Values are Ink color strings: any of the basic ANSI names, "gray", or hex.
 * Keeping to ANSI names by default keeps the TUI readable on terminals with
 * limited color support.
 */

export interface Theme {
  /** Stable id used in config + the picker. */
  id: string;
  /** Display name for the picker. */
  name: string;
  /** Primary brand / interactive color (selected rows, links, accent text). */
  accent: string;
  /** Less-loud accent for headings, secondary highlights. */
  accent2: string;
  /** Success states: done, applied, approved. */
  success: string;
  /** Warning states: pending approval, blurred, throttled. */
  warning: string;
  /** Error states: failed, denied. */
  error: string;
  /** Informational. */
  info: string;
  /** Dimmed / metadata text. */
  muted: string;
  /** Diff added line. */
  diffAdded: string;
  /** Diff removed line. */
  diffRemoved: string;
  /** Diff hunk marker. */
  diffHunk: string;
  /** Status badge color for running. */
  statusRunning: string;
  /** Status badge color for awaiting-approval. */
  statusAwaiting: string;
  /** Status badge color for done. */
  statusDone: string;
  /** Status badge color for error. */
  statusError: string;
  /** Status badge color for idle. */
  statusIdle: string;
}

export const DARK: Theme = {
  id: "dark",
  name: "Dark (default)",
  accent: "cyan",
  accent2: "magenta",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "cyan",
  muted: "gray",
  diffAdded: "green",
  diffRemoved: "red",
  diffHunk: "cyan",
  statusRunning: "cyan",
  statusAwaiting: "yellow",
  statusDone: "green",
  statusError: "red",
  statusIdle: "gray",
};

export const MONO: Theme = {
  id: "mono",
  name: "Mono",
  accent: "white",
  accent2: "white",
  success: "white",
  warning: "white",
  error: "white",
  info: "white",
  muted: "gray",
  diffAdded: "white",
  diffRemoved: "gray",
  diffHunk: "white",
  statusRunning: "white",
  statusAwaiting: "white",
  statusDone: "white",
  statusError: "white",
  statusIdle: "gray",
};

export const LIGHT: Theme = {
  id: "light",
  name: "Light",
  // Designed for light terminals: avoid pure white on white. Standard ANSI
  // colors render darker variants on light backgrounds in most terminals.
  accent: "blue",
  accent2: "magenta",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "blue",
  muted: "gray",
  diffAdded: "green",
  diffRemoved: "red",
  diffHunk: "blue",
  statusRunning: "blue",
  statusAwaiting: "yellow",
  statusDone: "green",
  statusError: "red",
  statusIdle: "gray",
};

export const THEMES: Record<string, Theme> = {
  dark: DARK,
  mono: MONO,
  light: LIGHT,
};

export function resolveTheme(id: string | undefined): Theme {
  if (!id) return DARK;
  return THEMES[id] ?? DARK;
}
