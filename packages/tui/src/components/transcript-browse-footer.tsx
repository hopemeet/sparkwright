import React, { useEffect } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { Key } from "ink";
import { ctrlTranscriptBoundaryKey } from "../lib/keybindings.js";
import { useTheme } from "../lib/theme-context.js";

export type TranscriptBrowseIntent = "close" | "line-up" | "line-down";

/**
 * Details mode is a modal transcript browser, so plain directional keys belong
 * to the viewport rather than to composer history/cursor movement.
 */
export function transcriptBrowseIntent(
  input: string,
  key: Key,
): TranscriptBrowseIntent | null {
  const unmodified = !key.ctrl && !key.meta && !key.shift;
  // Ink may mark a lone Escape as meta while resolving terminal escape
  // sequences. Details mode has no editor-level Meta+Escape meaning, so Escape
  // always closes the browser.
  if (key.escape) return "close";
  if (unmodified && key.upArrow) return "line-up";
  if (unmodified && key.downArrow) return "line-down";
  return null;
}

export function TranscriptBrowseFooter(props: {
  onClose(): void;
  onLineUp(): void;
  onLineDown(): void;
  onTop(): void;
  onBottom(): void;
  onGlobalInput(input: string, key: Key): boolean;
}): React.ReactElement {
  const theme = useTheme();
  const { stdin } = useStdin();

  useInput((input, key) => {
    const intent = transcriptBrowseIntent(input, key);
    if (intent === "close") {
      props.onClose();
      return;
    }
    if (intent === "line-up") {
      props.onLineUp();
      return;
    }
    if (intent === "line-down") {
      props.onLineDown();
      return;
    }
    props.onGlobalInput(input, key);
  });

  // Ink 5 does not expose Home/End on its public Key shape. The composer
  // recovers the explicit Ctrl variants from raw terminal data; details mode
  // needs the same bridge while the composer is intentionally unmounted.
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: unknown): void => {
      const boundary = ctrlTranscriptBoundaryKey(String(chunk));
      if (boundary === "home") props.onTop();
      else if (boundary === "end") props.onBottom();
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, props.onTop, props.onBottom]);

  return (
    <Box height={1} flexShrink={0} paddingX={1}>
      <Text color={theme.accent}>details</Text>
      <Text color={theme.muted}>
        {" "}
        · ↑/↓ scroll · PgUp/PgDn · Esc/Ctrl+T close
      </Text>
    </Box>
  );
}
