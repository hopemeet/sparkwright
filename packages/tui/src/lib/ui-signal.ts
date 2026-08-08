export type UiSignalKind =
  | "progress"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "action-required"
  | "blocking";

export type UiSignalScope =
  | "RunFailure"
  | "ConnectionFailure"
  | "ActionFailure"
  | "ActionSuccess"
  | "PanelLoadFailure"
  | "ValidationFailure"
  | "BackgroundTask"
  | "Approval"
  | "ActionInbox"
  | "Composer"
  | "Config";

export type UiSignalPersistence =
  | "transient"
  | "until-seen"
  | "until-resolved"
  | "timeline";

export type UiSignalAttention = "none" | "blurred";

export type UiSignalPresentation =
  | "toast"
  | "inline"
  | "status"
  | "action"
  | "timeline"
  | "history";

export interface UiSignalAction {
  id: string;
  label: string;
  key?: string;
}

export interface UiSignalInput {
  id?: string;
  kind: UiSignalKind;
  scope: UiSignalScope;
  source: string;
  title?: string;
  message: string;
  details?: unknown;
  persistence: UiSignalPersistence;
  attention?: UiSignalAttention;
  dedupeKey?: string;
  actions?: readonly UiSignalAction[];
  presentation: readonly UiSignalPresentation[];
  durationMs?: number | null;
  createdAt?: number;
}

export interface UiSignal extends Omit<UiSignalInput, "id" | "createdAt"> {
  id: string;
  createdAt: number;
  updatedAt: number;
  seen: boolean;
  resolved: boolean;
}

export interface PresentationPolicyInput {
  kind: UiSignalKind;
  scope: UiSignalScope;
}

/**
 * Pure TUI presentation policy. It intentionally knows nothing about Ink or
 * Host clients, so runtime truth remains in Host/Protocol while TUI producers
 * share one decision about where a signal belongs.
 */
export function presentationPolicy(
  input: PresentationPolicyInput,
): Pick<
  UiSignalInput,
  "persistence" | "attention" | "presentation" | "durationMs"
> {
  if (input.kind === "progress") {
    return {
      persistence: "transient",
      attention: "none",
      presentation: ["status"],
      durationMs: 0,
    };
  }
  if (input.scope === "Approval" || input.kind === "blocking") {
    return {
      persistence: "until-resolved",
      attention: "blurred",
      presentation: ["action", "history"],
      durationMs: null,
    };
  }
  if (input.scope === "ActionInbox") {
    return {
      persistence: "until-resolved",
      attention: "none",
      presentation: ["action", "history"],
      durationMs: null,
    };
  }
  if (input.scope === "RunFailure" || input.scope === "ConnectionFailure") {
    return {
      persistence: "until-resolved",
      attention: "blurred",
      presentation: ["inline", "history"],
      durationMs: null,
    };
  }
  if (input.scope === "BackgroundTask") {
    return input.kind === "error" || input.kind === "action-required"
      ? {
          persistence: "until-seen",
          attention: "blurred",
          presentation: ["status", "toast", "history"],
          durationMs: 7000,
        }
      : {
          persistence: "until-seen",
          attention: "none",
          presentation: ["status", "history"],
          durationMs: 0,
        };
  }
  if (
    input.scope === "PanelLoadFailure" ||
    input.scope === "ActionFailure" ||
    input.scope === "ValidationFailure"
  ) {
    return {
      persistence: "until-seen",
      attention: "none",
      presentation: ["toast", "history"],
      durationMs: input.kind === "error" ? 8000 : 5000,
    };
  }
  if (input.scope === "Config") {
    return {
      persistence: "until-resolved",
      attention: "none",
      presentation: ["status", "history"],
      durationMs: 0,
    };
  }
  if (input.scope === "Composer") {
    return {
      persistence: "until-seen",
      attention: "none",
      presentation: ["status"],
      durationMs: 0,
    };
  }
  return {
    persistence: "transient",
    attention: "none",
    presentation: ["toast", "history"],
    durationMs: input.kind === "success" ? 3000 : 3500,
  };
}

export type UiSignalSink = Pick<NotificationSignalPublisher, "publish">;

export interface NotificationSignalPublisher {
  publish(input: UiSignalInput): string;
}
