import { useEffect, useRef, useState, type RefObject } from "react";
import type { InputBoxHandle } from "../components/input-box.js";
import {
  loadSessionLabels,
  type SessionLabels,
} from "../lib/session-labels.js";
import type { SessionDiagnostics, SessionSummary } from "../lib/sessions.js";
import type { EventStore } from "./event-store.js";
import type { RunController } from "./run-controller.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";

/**
 * Session browsing, diagnostics, labels, rename, fork and export. Owns the
 * session-list / diagnostics / labels / rename-target state and the workspace
 * label-store load effect, so App carries only the wiring.
 */
export interface SessionActions {
  sessionList: SessionSummary[];
  sessionDiagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  labels: Record<string, string>;
  renameTarget: string | null;
  /** Clear the rename target (used by App's closeTopLayer). */
  setRenameTarget: (id: string | null) => void;
  openSessionList: () => Promise<void>;
  inspectSession: (id: string) => Promise<void>;
  pickSession: (id: string) => void;
  requestRename: (id: string) => void;
  /** Open the rename dialog for the current session (the /rename command). */
  renameCurrentSession: () => void;
  commitRename: (id: string, label: string) => void;
  forkSession: (
    forkAtSequence: number | undefined,
    label: string,
    edit?: boolean,
  ) => void;
  exportTranscript: () => void;
}

export function useSessionActions(deps: {
  workspaceRoot: string;
  sessionId: string | null;
  controller: RunController;
  store: EventStore;
  toasts: ToastStore;
  layers: LayerStack;
  inputHandleRef: RefObject<InputBoxHandle | null>;
}): SessionActions {
  const { workspaceRoot, sessionId, controller, store, toasts, layers } = deps;
  const { inputHandleRef } = deps;
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [sessionDiagnostics, setSessionDiagnostics] =
    useState<SessionDiagnostics | null>(null);
  const [loadingDiagnosticsFor, setLoadingDiagnosticsFor] = useState<
    string | null
  >(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const labelsRef = useRef<SessionLabels | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  // Load session labels once per workspace.
  useEffect(() => {
    let cancelled = false;
    void loadSessionLabels(workspaceRoot).then((loaded) => {
      if (cancelled) return;
      labelsRef.current = loaded;
      setLabels(loaded.get());
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  async function openSessionList(): Promise<void> {
    const sessions = await controller.listSessions();
    setSessionDiagnostics(null);
    setLoadingDiagnosticsFor(null);
    setSessionList(sessions);
    layers.push("sessions");
  }

  async function inspectSession(id: string): Promise<void> {
    setLoadingDiagnosticsFor(id);
    const diagnostics = await controller.inspectSession(id);
    setLoadingDiagnosticsFor(null);
    if (diagnostics) setSessionDiagnostics(diagnostics);
  }

  function pickSession(id: string): void {
    void controller.switchSession(id);
    layers.pop("sessions");
    toasts.push({
      variant: "success",
      message: `switched to session ${id}`,
    });
  }

  function requestRename(id: string): void {
    setRenameTarget(id);
    layers.push("session-rename");
  }

  function renameCurrentSession(): void {
    if (sessionId) setRenameTarget(sessionId);
    layers.push("session-rename");
  }

  function commitRename(id: string, label: string): void {
    void labelsRef.current?.set(id, label).then(() => {
      setLabels(labelsRef.current?.get() ?? {});
      toasts.push({
        variant: "success",
        title: label ? "renamed" : "cleared",
        message: id,
      });
    });
    layers.pop("session-rename");
    setRenameTarget(null);
  }

  function forkSession(
    forkAtSequence: number | undefined,
    label: string,
    edit?: boolean,
  ): void {
    const src = sessionId;
    layers.pop("fork");
    if (!src) return;
    void controller.forkSession(src, forkAtSequence).then((res) => {
      if (!res) return;
      // Switch to the fork AND load its (copied) history so the branched
      // conversation is visible, not a blank screen.
      void controller.switchSession(res.forkedSessionId);
      if (edit && label) inputHandleRef.current?.setValue(label);
      toasts.push({
        variant: "success",
        title: edit ? "forked — edit & resend" : "forked",
        message: `${res.forkedSessionId} (${res.copiedEventCount} events copied)`,
      });
    });
  }

  function exportTranscript(): void {
    controller
      .exportTranscript()
      .then((path) => {
        store.appendTranscriptExport(path);
        toasts.push({
          variant: "success",
          title: "transcript exported",
          message: path,
        });
      })
      .catch((err) =>
        toasts.push({
          variant: "error",
          title: "export failed",
          message: String(err),
        }),
      );
  }

  return {
    sessionList,
    sessionDiagnostics,
    loadingDiagnosticsFor,
    labels,
    renameTarget,
    setRenameTarget,
    openSessionList,
    inspectSession,
    pickSession,
    requestRename,
    renameCurrentSession,
    commitRename,
    forkSession,
    exportTranscript,
  };
}
