/**
 * Local opaque type for events delivered over the host protocol.
 *
 * The TUI no longer imports @sparkwright/core directly — events arrive as
 * the `event` field of host's run.event messages, where the protocol layer
 * types them as `unknown`. We mirror just enough fields here for the
 * EventStore, EventStream, and formatter to do their jobs.
 *
 * Keeping this local prevents reintroducing the runtime/UI coupling that
 * the host split was designed to eliminate.
 */
export interface RunEvent {
  /** Event type, e.g. "tool.requested", "model.stream.chunk". */
  type: string;
  /** Per-run monotonically increasing sequence number. */
  sequence: number;
  /** Stable event id; used as React key. */
  id?: string;
  /** ISO timestamp. */
  occurredAt?: string;
  /** Payload; shape is event-type-specific. */
  payload?: unknown;
  /** Event metadata; shape is event-type-specific and may be absent. */
  metadata?: Record<string, unknown>;
}
