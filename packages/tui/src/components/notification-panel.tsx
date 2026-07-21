import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { UiSignal } from "../lib/ui-signal.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

export function NotificationPanel(props: {
  signals: readonly UiSignal[];
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);
  const rows = useMemo(() => [...props.signals].reverse(), [props.signals]);
  const viewport = Math.max(5, (stdout?.rows ?? 24) - 9);
  const maxScroll = Math.max(0, rows.length - viewport);
  const clamped = Math.min(scroll, maxScroll);
  const visible = rows.slice(clamped, clamped + viewport);

  useInput((input, key) => {
    if (
      key.escape ||
      key.return ||
      (key.ctrl && input === "c") ||
      input.includes("\x03")
    ) {
      props.onClose();
      return;
    }
    if (key.downArrow || input === "j")
      setScroll((value) => Math.min(maxScroll, value + 1));
    else if (key.upArrow || input === "k")
      setScroll((value) => Math.max(0, value - 1));
    else if (key.pageDown || input === "d")
      setScroll((value) => Math.min(maxScroll, value + viewport));
    else if (key.pageUp || input === "u")
      setScroll((value) => Math.max(0, value - viewport));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(maxScroll);
  });

  return (
    <DialogFrame borderColor={theme.accent2}>
      <Text color={theme.accent2} bold>
        notifications
      </Text>
      {visible.length === 0 ? (
        <Text color={theme.muted}>No UI notifications in this process.</Text>
      ) : (
        visible.map((signal) => (
          <Box key={signal.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={signalColor(signal, theme)} bold>
                {signal.resolved ? "○" : signal.seen ? "◐" : "●"}{" "}
                {signal.title ?? signal.scope}
              </Text>
              <Text color={theme.muted}> · {signal.scope}</Text>
            </Text>
            <Text wrap="wrap">{signal.message}</Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          esc/enter/ctrl+c close
          {maxScroll > 0 ? " · ↑/↓ j/k · u/d page" : ""}
        </Text>
      </Box>
    </DialogFrame>
  );
}

function signalColor(
  signal: UiSignal,
  theme: ReturnType<typeof useTheme>,
): string {
  if (signal.kind === "error") return theme.error;
  if (signal.kind === "warning" || signal.kind === "action-required")
    return theme.warning;
  if (signal.kind === "success") return theme.success;
  return theme.info;
}
