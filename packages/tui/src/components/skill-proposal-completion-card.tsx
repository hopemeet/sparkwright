import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PendingHumanAction } from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";
import { KeyHints } from "./key-hints.js";

/**
 * Skill inbox action surface. It owns its action keys and confirmation state;
 * App only supplies callbacks and never interprets a/r/esc.
 */
export function SkillProposalCompletionCard(props: {
  action: PendingHumanAction;
  active: boolean;
  onReview: (proposalId: string) => void;
  onApply: (proposalId: string) => Promise<boolean>;
  onDismiss: (proposalId: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  const { action } = props;
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setConfirmingApply(false);
    setApplying(false);
  }, [action.proposalId]);

  useInput(
    (input, key) => {
      if (applying) return;
      const cancelling =
        key.escape || (key.ctrl && input === "c") || input.includes("\x03");
      if (confirmingApply) {
        if (key.return) {
          setApplying(true);
          void props.onApply(action.proposalId).then((applied) => {
            if (!applied) setApplying(false);
          });
          return;
        }
        if (cancelling) setConfirmingApply(false);
        return;
      }
      if (cancelling) {
        props.onDismiss(action.proposalId);
        return;
      }
      if (input === "r") {
        props.onReview(action.proposalId);
        return;
      }
      if (input === "a" && action.eligibility === "quick_apply") {
        setConfirmingApply(true);
      }
    },
    { isActive: props.active },
  );

  const hints = applying
    ? []
    : confirmingApply
      ? [
          { keys: "enter", label: "confirm apply" },
          { keys: "esc", label: "cancel" },
        ]
      : action.eligibility === "quick_apply"
        ? [
            { keys: "a", label: "apply" },
            { keys: "r", label: "review diff" },
            { keys: "esc", label: "dismiss" },
          ]
        : [
            { keys: "r", label: "review proposal" },
            { keys: "esc", label: "dismiss" },
          ];

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
      {applying ? (
        <Text color={theme.warning}>
          applying proposal… duplicate input disabled
        </Text>
      ) : confirmingApply ? (
        <Text color={theme.warning}>Apply this prepared proposal?</Text>
      ) : null}
      {hints.length > 0 ? <KeyHints hints={hints} /> : null}
    </Box>
  );
}
