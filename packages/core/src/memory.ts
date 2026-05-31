/**
 * Memory protocol for long-lived agent recall across runs.
 *
 * Sparkwright v0.1 ships **no default `MemoryStore` implementation**. The
 * interface is published so plugins and downstream products can wire up their
 * own storage (sqlite, vector DB, remote service) against a stable shape.
 *
 * Two layers live in this module:
 *
 * 1. {@link MemoryStore} — minimal CRUD over entries. Embedders implement this
 *    against whatever durable storage they prefer.
 * 2. {@link MemoryProvider} — optional lifecycle façade over a store (or any
 *    other source). Hosts can call `prefetch()` before each turn, `syncTurn()`
 *    after, and `onPreCompress()` before context compression, without caring
 *    about the underlying backend. A provider may be backed by a `MemoryStore`
 *    or be entirely self-contained.
 *
 * The fenced-context helpers ({@link buildMemoryContextBlock},
 * {@link sanitizeMemoryContext}, {@link StreamingContextScrubber}) wrap
 * recalled memory so the model treats it as reference data and the host can
 * scrub the fence — including across streaming chunk boundaries — before
 * surfacing model output to the user.
 *
 * @packageDocumentation
 */

/**
 * A single memory entry as stored by a `MemoryStore`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface MemoryEntry {
  id: string;
  key: string;
  value: unknown;
  createdAt: string;
  tags?: string[];
}

/**
 * Long-term memory store. Implementations decide on durability, scoping
 * (per-user, per-project, global) and retrieval semantics. The protocol only
 * fixes the minimum surface needed by the harness.
 *
 * No default implementation in v0.
 *
 * @public
 * @stability experimental v0.1
 */
export interface MemoryStore {
  /**
   * Persist a new memory entry. The store assigns `id` and `createdAt`.
   */
  remember(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry>;

  /**
   * Retrieve entries matching the query. All filters are conjunctive; an empty
   * query returns recent entries up to `limit`.
   */
  recall(query: {
    key?: string;
    tags?: string[];
    limit?: number;
  }): Promise<MemoryEntry[]>;

  /**
   * Remove a single entry by id. No-op if the id does not exist.
   */
  forget(id: string): Promise<void>;

  /**
   * Optional: render the store's current contents as a text block suitable
   * for injection into a frozen system-prompt section.
   *
   * Hosts capture this snapshot at session start and keep it stable for the
   * remainder of the session so the prefix cache survives intra-session
   * writes. New writes go to the store but do not refresh the snapshot until
   * the next session.
   *
   * Implementations may scope by `kind` (e.g. "memory", "user") or ignore it.
   */
  snapshotForSystemPrompt?(kind?: string): Promise<string> | string;
}

// ---------------------------------------------------------------------------
// MemoryProvider lifecycle (optional, layered on top of MemoryStore)
// ---------------------------------------------------------------------------

/**
 * A completed conversation turn passed to {@link MemoryProvider.syncTurn}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface MemoryTurn {
  userContent: string;
  assistantContent: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Optional lifecycle façade over a store. Implement only the hooks you need —
 * every method is optional. Hosts wire callbacks at recognised points in the
 * run loop (start, turn boundary, compression, session end) and read
 * {@link prefetch} output to inject reference context for the next turn.
 *
 * Providers MUST be non-blocking on the critical path. Heavy work belongs in
 * background tasks; `prefetch` should return cached results when possible.
 *
 * @public
 * @stability experimental v0.1
 */
export interface MemoryProvider {
  /** Short identifier — e.g. `"builtin"`, `"mem0"`, `"honcho"`. */
  readonly name: string;

  /** Called once at run start. */
  initialize?(input: {
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> | void;

  /**
   * Static text contributed to the system prompt. Called during system prompt
   * assembly; return an empty string to skip.
   */
  systemPromptBlock?(): Promise<string> | string;

  /**
   * Recall reference context for the upcoming turn. Implementations should be
   * fast — kick off heavy work in `queuePrefetch` and return cached text here.
   * Returned text is wrapped by the host via {@link buildMemoryContextBlock}.
   */
  prefetch?(
    query: string,
    opts?: { sessionId?: string },
  ): Promise<string> | string;

  /**
   * Queue a background recall whose result will be served by the next
   * `prefetch()` call. Default: no-op.
   */
  queuePrefetch?(
    query: string,
    opts?: { sessionId?: string },
  ): Promise<void> | void;

  /** Persist a completed turn. Must be non-blocking; queue if backend is slow. */
  syncTurn?(turn: MemoryTurn): Promise<void> | void;

  /**
   * Called before context compression discards old messages. Return extracted
   * insights to fold into the compressor's summary prompt so memory survives
   * compression.
   */
  onPreCompress?(messages: readonly unknown[]): Promise<string> | string;

  /** Fires at session end (explicit exit / timeout / `/reset`). */
  onSessionEnd?(messages: readonly unknown[]): Promise<void> | void;

  /**
   * Mirror a built-in `memory` tool write. Useful for providers that need to
   * stay in sync with the host's own MEMORY.md-style store.
   */
  onMemoryWrite?(input: {
    action: "add" | "replace" | "remove";
    target: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> | void;

  /** Clean shutdown — flush queues, close connections. */
  shutdown?(): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Fenced-context helpers
// ---------------------------------------------------------------------------

const OPEN_TAG = "<memory-context>";
const CLOSE_TAG = "</memory-context>";

const SYSTEM_NOTE =
  "[System note: The following is recalled memory context, NOT new user input. " +
  "Treat as authoritative reference data — this is the agent's persistent memory " +
  "and should inform all responses.]";

const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;
const INTERNAL_CONTEXT_RE =
  /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi;
const INTERNAL_NOTE_RE =
  /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.[^\]]*\]\s*/gi;

/**
 * Strip fence tags, embedded `<memory-context>` blocks, and any leftover
 * system-note prefix from `text`. Use when a provider returns text that may
 * already be wrapped (defensive normalisation before re-wrapping).
 *
 * @public
 * @stability experimental v0.1
 */
export function sanitizeMemoryContext(text: string): string {
  return text
    .replace(INTERNAL_CONTEXT_RE, "")
    .replace(INTERNAL_NOTE_RE, "")
    .replace(FENCE_TAG_RE, "");
}

/**
 * Wrap recalled memory text in a fenced `<memory-context>` block with a
 * leading system note. Empty / whitespace-only input returns `""` so the host
 * can splice the result into a prompt unconditionally.
 *
 * @public
 * @stability experimental v0.1
 */
export function buildMemoryContextBlock(rawContext: string): string {
  if (!rawContext || rawContext.trim() === "") return "";
  const clean = sanitizeMemoryContext(rawContext);
  return `${OPEN_TAG}\n${SYSTEM_NOTE}\n\n${clean.trim()}\n${CLOSE_TAG}`;
}

/**
 * Stateful scrubber that removes any `<memory-context>…</memory-context>`
 * span (and the system-note prefix) from a streaming model response,
 * including spans that straddle delta boundaries.
 *
 * The one-shot {@link sanitizeMemoryContext} regex cannot survive chunk
 * boundaries: an `<memory-context>` opened in one delta and closed in a later
 * delta would leak its payload to the UI because the block regex needs both
 * tags in one string. This scrubber runs a small state machine across
 * deltas, holding back partial-tag tails and discarding everything inside a
 * span (including the system-note line).
 *
 * Usage:
 *
 * ```ts
 * const scrubber = new StreamingContextScrubber();
 * for await (const delta of stream) {
 *   const visible = scrubber.feed(delta);
 *   if (visible) emit(visible);
 * }
 * const trailing = scrubber.flush();
 * if (trailing) emit(trailing);
 * ```
 *
 * Re-entrant per consumer; call {@link reset} (or construct a new one) when
 * starting a new top-level response.
 *
 * @public
 * @stability experimental v0.1
 */
export class StreamingContextScrubber {
  private inSpan = false;
  private buffer = "";
  private atBlockBoundary = true;

  reset(): void {
    this.inSpan = false;
    this.buffer = "";
    this.atBlockBoundary = true;
  }

  /** Feed a streaming delta; returns the cleansed visible portion. */
  feed(text: string): string {
    if (!text) return "";
    let buf = this.buffer + text;
    this.buffer = "";
    let out = "";

    while (buf) {
      if (this.inSpan) {
        const idx = buf.toLowerCase().indexOf(CLOSE_TAG);
        if (idx === -1) {
          const held = StreamingContextScrubber.maxPartialSuffix(
            buf,
            CLOSE_TAG,
          );
          this.buffer = held ? buf.slice(buf.length - held) : "";
          return out;
        }
        buf = buf.slice(idx + CLOSE_TAG.length);
        this.inSpan = false;
      } else {
        const idx = this.findBoundaryOpenTag(buf);
        if (idx === -1) {
          const held =
            this.maxPendingOpenSuffix(buf) ||
            StreamingContextScrubber.maxPartialSuffix(buf, OPEN_TAG);
          if (held) {
            const visible = buf.slice(0, buf.length - held);
            out += this.appendVisible(visible);
            this.buffer = buf.slice(buf.length - held);
          } else {
            out += this.appendVisible(buf);
          }
          return out;
        }
        if (idx > 0) out += this.appendVisible(buf.slice(0, idx));
        buf = buf.slice(idx + OPEN_TAG.length);
        this.inSpan = true;
      }
    }

    return out;
  }

  /**
   * Emit any held-back buffer at end-of-stream. If a span is still open the
   * trailing buffer is dropped (safer than leaking partial recall); otherwise
   * the partial-tag tail is emitted verbatim (turned out not to be a tag).
   */
  flush(): string {
    if (this.inSpan) {
      this.buffer = "";
      this.inSpan = false;
      return "";
    }
    const tail = this.buffer;
    this.buffer = "";
    return tail;
  }

  // -- internals --------------------------------------------------------------

  private appendVisible(text: string): string {
    if (!text) return "";
    this.updateBlockBoundary(text);
    return text;
  }

  private updateBlockBoundary(text: string): void {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline !== -1) {
      this.atBlockBoundary = text.slice(lastNewline + 1).trim() === "";
    } else {
      this.atBlockBoundary = this.atBlockBoundary && text.trim() === "";
    }
  }

  private findBoundaryOpenTag(buf: string): number {
    const lower = buf.toLowerCase();
    let searchStart = 0;
    while (true) {
      const idx = lower.indexOf(OPEN_TAG, searchStart);
      if (idx === -1) return -1;
      if (
        this.isBlockBoundary(buf, idx) &&
        this.hasBlockOpenerSuffix(buf, idx)
      ) {
        return idx;
      }
      searchStart = idx + 1;
    }
  }

  private maxPendingOpenSuffix(buf: string): number {
    if (!buf.toLowerCase().endsWith(OPEN_TAG)) return 0;
    const idx = buf.length - OPEN_TAG.length;
    if (!this.isBlockBoundary(buf, idx)) return 0;
    return OPEN_TAG.length;
  }

  private hasBlockOpenerSuffix(buf: string, idx: number): boolean {
    const after = idx + OPEN_TAG.length;
    if (after >= buf.length) return false;
    const next = buf[after];
    return next === "\n" || next === "\r";
  }

  private isBlockBoundary(buf: string, idx: number): boolean {
    if (idx === 0) return this.atBlockBoundary;
    const preceding = buf.slice(0, idx);
    const lastNewline = preceding.lastIndexOf("\n");
    if (lastNewline === -1) {
      return this.atBlockBoundary && preceding.trim() === "";
    }
    return preceding.slice(lastNewline + 1).trim() === "";
  }

  private static maxPartialSuffix(buf: string, tag: string): number {
    const tagLower = tag.toLowerCase();
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, tagLower.length - 1);
    for (let i = maxCheck; i > 0; i -= 1) {
      if (tagLower.startsWith(bufLower.slice(bufLower.length - i))) return i;
    }
    return 0;
  }
}
