import React from "react";
import { Box, Text, useStdout } from "ink";
import type { Toast as ToastT, ToastVariant } from "../state/toast-store.js";
import { useTheme } from "../lib/theme-context.js";
import { dialogFrameWidth, resolveDialogColumns } from "./dialog-frame.js";

const VARIANT_ICON: Record<ToastVariant, string> = {
  info: "i",
  success: "✓",
  warning: "!",
  error: "✗",
};

export function ToastView(props: {
  toast: ToastT | null;
  queueDepth: number;
}): React.ReactElement | null {
  const t = props.toast;
  const theme = useTheme();
  const { stdout } = useStdout();
  if (!t) return null;
  const width = dialogFrameWidth(resolveDialogColumns(stdout?.columns));
  const color =
    t.variant === "success"
      ? theme.success
      : t.variant === "warning"
        ? theme.warning
        : t.variant === "error"
          ? theme.error
          : theme.info;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      <Box>
        <Text color={color} bold>
          {VARIANT_ICON[t.variant]} {t.title ?? t.variant}
        </Text>
        {props.queueDepth > 0 ? (
          <Text color={theme.muted}> (+{props.queueDepth} queued)</Text>
        ) : null}
      </Box>
      <Text>{t.message}</Text>
    </Box>
  );
}
