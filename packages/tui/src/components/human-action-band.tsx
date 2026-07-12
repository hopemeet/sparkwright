import React from "react";
import { Box, Text } from "ink";
import type { PendingHumanAction } from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";

export function HumanActionBand(props: {
  action: PendingHumanAction;
  confirmingApply: boolean;
  applying: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const action = props.action;
  return (
    <Box paddingX={1} flexDirection="column">
      <Text>
        <Text color={theme.success}>skill proposal ready</Text>
        <Text color={theme.muted}>
          {` · ${action.proposalId} · validation ${action.validationStatus} · ${action.guardSeverity} findings`}
        </Text>
      </Text>
      {props.applying ? (
        <Text color={theme.warning}>applying proposal…</Text>
      ) : props.confirmingApply ? (
        <Text color={theme.warning}>
          confirm apply · enter confirm · esc cancel
        </Text>
      ) : (
        <Text color={theme.muted}>
          {action.eligibility === "quick_apply"
            ? "a apply · r review diff · esc dismiss"
            : "r review proposal · esc dismiss"}
        </Text>
      )}
    </Box>
  );
}
