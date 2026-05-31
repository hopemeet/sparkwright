// =============================================================================
// AI maintenance note
//
// CommandExtension is the *user intent* surface — slash commands the user
// types into a CLI/desktop/bot. It is intentionally distinct from
// ToolDefinition (which is what the model invokes during a run):
//
//   - Tools are reasoned about by the LLM and gated by policy/approval.
//   - Commands are typed by the user. They may start a new run, mutate
//     session state, fetch usage stats, switch modes, etc. — they do NOT
//     pass through the tool gate.
//
// Embedders (CLI, desktop, IM bots) all need the same registry, parser, and
// dispatch shape. This module owns that contract so each front-end doesn't
// reinvent it.
//
// See docs/EXTENSION_INTERFACES.md "Commands".
// =============================================================================

export interface CommandContext {
  /**
   * Raw input as the user typed it, including the leading slash if present.
   * @reserved Public command-protocol field consumed by command handlers.
   */
  raw: string;
  /** Command name without the leading slash (e.g. "compact"). */
  name: string;
  /** Positional args after the command name, whitespace-split. */
  args: string[];
  /**
   * Free-form rest-of-line after the command name (preserves quoting).
   * @reserved Public command-protocol field consumed by command handlers.
   */
  rest: string;
  /**
   * Opaque per-invocation id for tracing/correlation.
   * @reserved Public command-protocol field consumed by command handlers.
   */
  invocationId: string;
  /** Caller-provided context (cwd, runId, sessionId, transport, etc.). */
  metadata: Record<string, unknown>;
}

export interface CommandResult {
  status: "ok" | "error";
  message?: string;
  metadata?: Record<string, unknown>;
}

export type CommandScope = "user" | "session" | "run";

export interface CommandDefinition {
  /** Canonical name without the leading slash. Must be unique per registry. */
  name: string;
  /** One-line human description (shown in `/help`-style listings). */
  describe: string;
  /** Optional aliases (without leading slash). */
  aliases?: string[];
  /**
   * Scope hints for embedders that distinguish per-user vs per-session vs
   * per-run state. Pure documentation; the registry does not enforce it.
   * @reserved Public command-protocol field consumed by command UIs.
   */
  scope?: CommandScope;
  /** Optional usage string for `/help <name>`. */
  usage?: string;
  /** Optional free-form metadata (category, plugin id, etc.). */
  metadata?: Record<string, unknown>;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}

export interface CommandRegistryOptions {
  /**
   * Leading prefix for slash commands. Defaults to "/". Set to "" if the
   * embedder doesn't use slashes (e.g. a chat where every line is a command).
   */
  prefix?: string;
}

export interface CommandResolution {
  definition: CommandDefinition;
  context: CommandContext;
}

export class CommandRegistry {
  private readonly defs = new Map<string, CommandDefinition>();
  private readonly aliasMap = new Map<string, string>();
  private readonly prefix: string;
  private invocationCounter = 0;

  constructor(options: CommandRegistryOptions = {}) {
    this.prefix = options.prefix ?? "/";
  }

  register(definition: CommandDefinition): void {
    if (!definition.name || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(definition.name)) {
      throw new Error(
        `Invalid command name: ${JSON.stringify(definition.name)}`,
      );
    }
    if (this.defs.has(definition.name)) {
      throw new Error(`Command already registered: ${definition.name}`);
    }
    if (this.aliasMap.has(definition.name)) {
      throw new Error(
        `Command name conflicts with an existing alias: ${definition.name}`,
      );
    }
    this.defs.set(definition.name, definition);
    for (const alias of definition.aliases ?? []) {
      if (this.defs.has(alias) || this.aliasMap.has(alias)) {
        throw new Error(`Command alias conflicts: ${alias}`);
      }
      this.aliasMap.set(alias, definition.name);
    }
  }

  unregister(name: string): boolean {
    const def = this.defs.get(name);
    if (!def) return false;
    this.defs.delete(name);
    for (const alias of def.aliases ?? []) this.aliasMap.delete(alias);
    return true;
  }

  list(): CommandDefinition[] {
    return [...this.defs.values()];
  }

  get(name: string): CommandDefinition | undefined {
    return this.defs.get(name) ?? this.defs.get(this.aliasMap.get(name) ?? "");
  }

  /**
   * Parse `input` and resolve to a `CommandDefinition` + `CommandContext`.
   * Returns `undefined` when the input does not look like a command (does not
   * start with the configured prefix) or when no command matches.
   */
  resolve(
    input: string,
    metadata: Record<string, unknown> = {},
  ): CommandResolution | undefined {
    const trimmed = input.trimStart();
    if (this.prefix && !trimmed.startsWith(this.prefix)) return undefined;
    const body = this.prefix ? trimmed.slice(this.prefix.length) : trimmed;
    if (!body) return undefined;

    const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return undefined;
    const name = match[1]!;
    const rest = match[2]?.trim() ?? "";
    const def = this.get(name);
    if (!def) return undefined;

    this.invocationCounter += 1;
    const context: CommandContext = {
      raw: input,
      name: def.name,
      args: rest ? rest.split(/\s+/) : [],
      rest,
      invocationId: `cmd_${Date.now().toString(36)}_${this.invocationCounter}`,
      metadata,
    };
    return { definition: def, context };
  }

  /**
   * Resolve + execute. Returns a structured error result when no command
   * matches, so embedders can render the failure consistently.
   */
  async dispatch(
    input: string,
    metadata: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    const resolved = this.resolve(input, metadata);
    if (!resolved) {
      return {
        status: "error",
        message: `Unknown command: ${input}`,
      };
    }
    try {
      return await resolved.definition.run(resolved.context);
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        metadata: { cause: err },
      };
    }
  }
}
