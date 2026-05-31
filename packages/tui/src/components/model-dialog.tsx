import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../lib/theme-context.js";

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
  onCommit: (model: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [model, setModel] = useState(props.model);
  // Until the user edits, the pre-filled current model is not used as a filter
  // (otherwise the list would collapse to just the current entry on open).
  const [edited, setEdited] = useState(false);
  const candidates = props.candidates ?? [];
  const [highlight, setHighlight] = useState(() => {
    const i = candidates.indexOf(props.model);
    return i >= 0 ? i : 0;
  });
  const [selectionTouched, setSelectionTouched] = useState(false);

  const filtered = useMemo(() => {
    if (!edited) return candidates.slice(0, 8);
    const q = model.trim().toLowerCase();
    const matches = q
      ? candidates.filter((c) => c.toLowerCase().includes(q))
      : candidates;
    return matches.slice(0, 8);
  }, [candidates, model, edited]);

  const clampedHighlight =
    filtered.length === 0 ? 0 : Math.min(highlight, filtered.length - 1);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectionTouched(true);
      setHighlight((h) => (h <= 0 ? Math.max(filtered.length - 1, 0) : h - 1));
      return;
    }
    if (key.downArrow) {
      setSelectionTouched(true);
      setHighlight((h) => (h >= filtered.length - 1 ? 0 : h + 1));
      return;
    }
    if (key.tab) {
      const pick = filtered[clampedHighlight];
      if (pick) {
        setModel(pick);
        setEdited(true);
      }
      return;
    }
    if (key.return) {
      const pick = selectionTouched ? filtered[clampedHighlight] : undefined;
      props.onCommit((pick ?? model).trim());
      return;
    }
    if (key.backspace || key.delete) {
      setModel((m) => (edited ? m.slice(0, -1) : ""));
      setEdited(true);
      setSelectionTouched(false);
      setHighlight(0);
      return;
    }
    if (key.ctrl && input === "u") {
      setModel("");
      setEdited(true);
      setSelectionTouched(false);
      setHighlight(0);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) {
      // First keystroke replaces the pre-filled current model (select-all feel).
      setModel((m) => (edited ? m + input : input));
      setEdited(true);
      setSelectionTouched(false);
      setHighlight(0);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box>
        <Text color={theme.accent} bold>
          model
        </Text>
        <Text color={theme.muted}>
          {"  "}↑↓ select · tab fill · enter apply · esc cancel
        </Text>
      </Box>
      <Box>
        <Text color={theme.success}>{"› "}model: </Text>
        <Text>{model || ""}</Text>
        <Text color={theme.accent}>▎</Text>
        {!model ? (
          <Text color={theme.muted}>e.g. openai/gpt-5.4-mini</Text>
        ) : null}
      </Box>
      {filtered.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {filtered.map((ref, i) => (
            <Text
              key={ref}
              color={i === clampedHighlight ? theme.accent : undefined}
              dimColor={i !== clampedHighlight}
            >
              {i === clampedHighlight ? "❯ " : "  "}
              {ref}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
