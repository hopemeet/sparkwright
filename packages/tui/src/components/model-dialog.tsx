import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../lib/theme-context.js";
import { isBackInput } from "../lib/input-key.js";
import { windowAroundCursor } from "../lib/list-window.js";
import { DialogFrame } from "./dialog-frame.js";
import type {
  ProviderAuthStatus,
  ProviderCatalogSnapshot,
} from "@sparkwright/protocol";

interface ModelCandidate {
  ref: string;
  profileId?: string;
  authStatus?: ProviderAuthStatus;
}

/**
 * Switch the model reference at runtime. A free-text "provider/model" ref
 * (e.g. "openai/gpt-5.4-mini") or the reserved "deterministic", with a
 * candidate list sourced from the configured providers' `models` maps.
 *
 * The field opens pre-filled with the current model and the full candidate
 * list shown (current one highlighted) — pressing a key replaces the pre-fill
 * and starts type-to-filter, so the list is reachable without clearing first.
 * The typed text is always the committed value, so models not present in the
 * list can still be entered by hand.
 *
 * Applies to the NEXT run (the controller hot-swaps; in-flight is untouched).
 * Up/down move the selection, tab fills the highlighted candidate, enter
 * commits the highlighted candidate after navigation or the current text
 * otherwise, esc cancels.
 */
export function ModelDialog(props: {
  model: string;
  candidates?: string[];
  catalog?: ProviderCatalogSnapshot | null;
  loading?: boolean;
  onCommit: (model: string) => void;
  onCancel: () => void;
  onAuth?: (action: "login" | "logout" | "refresh", profileId: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [model, setModel] = useState(props.model);
  // Until the user edits, the pre-filled current model is not used as a filter
  // (otherwise the list would collapse to just the current entry on open).
  const [edited, setEdited] = useState(false);
  const candidates = useMemo<ModelCandidate[]>(() => {
    if (props.catalog) {
      return props.catalog.providers.flatMap((provider) =>
        provider.models.map((candidate) => ({
          ref: candidate.ref,
          profileId: provider.credential.id,
          authStatus: provider.credential.status,
        })),
      );
    }
    return (props.candidates ?? []).map((ref) => ({ ref }));
  }, [props.candidates, props.catalog]);
  // Track the selection by stable model ref, not array index. The provider
  // catalog arrives asynchronously and may reorder the fallback candidates.
  const [highlightedRef, setHighlightedRef] = useState(props.model);
  const [selectionTouched, setSelectionTouched] = useState(false);

  useEffect(() => {
    if (!edited && !selectionTouched) setHighlightedRef(props.model);
  }, [edited, props.model, selectionTouched]);

  const filtered = useMemo(() => {
    if (!edited) return candidates;
    const q = model.trim().toLowerCase();
    const matches = q
      ? candidates.filter((candidate) =>
          candidate.ref.toLowerCase().includes(q),
        )
      : candidates;
    return matches;
  }, [candidates, model, edited]);

  const highlightedIndex =
    filtered.length === 0
      ? 0
      : Math.max(
          0,
          filtered.findIndex((candidate) => candidate.ref === highlightedRef),
        );
  const { start: visibleStart, visible } = windowAroundCursor(
    filtered,
    highlightedIndex,
    8,
  );

  function authTarget(): ModelCandidate | undefined {
    const highlighted = filtered[highlightedIndex];
    if (highlighted?.profileId) return highlighted;
    const providerId = model.trim().split("/", 1)[0];
    const provider = props.catalog?.providers.find(
      (candidate) => candidate.id === providerId,
    );
    return provider
      ? {
          ref: model,
          profileId: provider.credential.id,
          authStatus: provider.credential.status,
        }
      : undefined;
  }

  useInput((input, key) => {
    if (isBackInput(input, key)) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectionTouched(true);
      const nextIndex =
        highlightedIndex <= 0
          ? Math.max(filtered.length - 1, 0)
          : highlightedIndex - 1;
      setHighlightedRef(filtered[nextIndex]?.ref ?? "");
      return;
    }
    if (key.downArrow) {
      setSelectionTouched(true);
      const nextIndex =
        highlightedIndex >= filtered.length - 1 ? 0 : highlightedIndex + 1;
      setHighlightedRef(filtered[nextIndex]?.ref ?? "");
      return;
    }
    if (key.tab) {
      const pick = filtered[highlightedIndex];
      if (pick) {
        setModel(pick.ref);
        setEdited(true);
        setHighlightedRef(pick.ref);
      }
      return;
    }
    if (key.ctrl && (input === "l" || input === "o" || input === "r")) {
      if (props.loading) return;
      const target = authTarget();
      if (target?.profileId) {
        props.onAuth?.(
          input === "l" ? "login" : input === "o" ? "logout" : "refresh",
          target.profileId,
        );
      }
      return;
    }
    if (key.return) {
      const pick = selectionTouched ? filtered[highlightedIndex] : undefined;
      props.onCommit((pick?.ref ?? model).trim());
      return;
    }
    if (key.backspace || key.delete) {
      setModel((m) => (edited ? m.slice(0, -1) : ""));
      setEdited(true);
      setSelectionTouched(false);
      setHighlightedRef("");
      return;
    }
    if (key.ctrl && input === "u") {
      setModel("");
      setEdited(true);
      setSelectionTouched(false);
      setHighlightedRef("");
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) {
      // First keystroke replaces the pre-filled current model (select-all feel).
      setModel((m) => (edited ? m + input : input));
      setEdited(true);
      setSelectionTouched(false);
      setHighlightedRef("");
    }
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          model
        </Text>
        <Text color={theme.muted}>
          {"  "}↑↓ select · tab fill · enter apply · esc cancel
        </Text>
      </Box>
      {props.onAuth ? (
        <Text color={theme.muted}>
          auth selected provider · ctrl+l login · ctrl+o logout · ctrl+r refresh
        </Text>
      ) : null}
      <Box>
        <Text color={theme.success}>{"› "}model: </Text>
        <Text>{model || ""}</Text>
        <Text color={theme.accent}>▎</Text>
        {!model ? (
          <Text color={theme.muted}>e.g. openai/gpt-5.4-mini</Text>
        ) : null}
      </Box>
      {props.catalog ? (
        <Text color={theme.muted}>
          status: ✓ ready · ~ unverified · ○ missing · × disconnected
        </Text>
      ) : null}
      {props.loading ? (
        <Text color={theme.muted}>loading provider catalog…</Text>
      ) : null}
      {visible.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((candidate, i) => {
            const selected = visibleStart + i === highlightedIndex;
            return (
              <Text
                key={candidate.ref}
                color={selected ? theme.accent : undefined}
                dimColor={!selected}
              >
                {selected ? "❯ " : "  "}
                {authMark(candidate.authStatus)} {candidate.ref}
              </Text>
            );
          })}
        </Box>
      ) : !props.loading ? (
        <Text color={theme.muted}>(no matching models)</Text>
      ) : null}
      {filtered.length > visible.length ? (
        <Text color={theme.muted}>
          {visibleStart + 1}-{visibleStart + visible.length} of{" "}
          {filtered.length}
        </Text>
      ) : null}
    </DialogFrame>
  );
}

function authMark(status: ProviderAuthStatus | undefined): string {
  if (status === "ready") return "✓";
  if (status === "unverified") return "~";
  if (status === "logged_out" || status === "suppressed") return "×";
  if (status === "missing" || status === "unconfigured") return "○";
  if (status === "failed" || status === "needs_refresh") return "!";
  return " ";
}
