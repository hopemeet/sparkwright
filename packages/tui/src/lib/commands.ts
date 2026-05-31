/**
 * Command registry. The palette and the `/foo` slash input share this list so
 * a command added once is reachable both ways.
 *
 * Commands are pure descriptors; the `run` callback closes over App state.
 * `available()` is consulted at lookup time so the palette can hide commands
 * that don't make sense in the current state (e.g. "cancel" when idle).
 */

// Intentionally empty: the registry stores `run` as a thunk closed over
// App-scoped helpers. Keep the type extensible for future ctx fields.
export type CommandCtx = Record<string, never>;

export interface Command {
  /** Unique id, also the slash command (e.g. "help" → /help). */
  name: string;
  /** Short label shown in the palette and help. */
  title: string;
  /** One-line description. */
  description: string;
  /** Category label (groups palette rows). */
  category: "session" | "config" | "view" | "system";
  /** Optional aliases for the slash input. */
  aliases?: string[];
  /** Keyboard hint shown on the right side of the palette row. */
  hint?: string;
  /** Whether the command is currently selectable. */
  available?: () => boolean;
  /** Called when the user picks the command. */
  run: () => void | Promise<void>;
}

export class CommandRegistry {
  private byName = new Map<string, Command>();

  register(cmd: Command): void {
    this.byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) this.byName.set(a, cmd);
  }

  resolve(input: string): Command | undefined {
    return this.byName.get(input.trim().toLowerCase());
  }

  /**
   * All canonical commands (alias entries deduped), in registration order.
   * Available()-false commands are kept so the palette can grey them out.
   */
  list(): Command[] {
    const seen = new Set<string>();
    const out: Command[] = [];
    for (const cmd of this.byName.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
    return out;
  }

  /**
   * Fuzzy-ish filter — exact substring on name / title / description.
   * Returns commands ranked by where the match occurred.
   */
  search(query: string): Command[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    const scored: Array<{ cmd: Command; score: number }> = [];
    for (const cmd of this.list()) {
      const name = cmd.name.toLowerCase();
      const title = cmd.title.toLowerCase();
      const desc = cmd.description.toLowerCase();
      let score = -1;
      if (name.startsWith(q)) score = 0;
      else if (name.includes(q)) score = 1;
      else if (title.includes(q)) score = 2;
      else if (desc.includes(q)) score = 3;
      if (score >= 0) scored.push({ cmd, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.cmd);
  }
}
