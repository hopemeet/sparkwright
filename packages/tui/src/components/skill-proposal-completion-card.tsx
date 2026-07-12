import React from "react";
import { Box, Text } from "ink";
import type { PendingHumanAction } from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";

/** A durable-review completion card, replacing the transient action band. */
export function SkillProposalCompletionCard(props: {
  action: PendingHumanAction;
  confirmingApply: boolean;
  applying: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const { action } = props;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      flexDirection="column"
      paddingX={1}
    >
      <Text>
        <Text color={theme.success}>Skill proposal ready for review</Text>
        <Text color={theme.muted}>{` · ${action.proposalId}`}</Text>
      </Text>
      <Text color={theme.muted}>
        {`Stored in the Skill inbox · validation ${action.validationStatus} · ${action.guardSeverity} findings`}
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
