import React from "react";
import { Box, Text } from "ink";
import type { StoreState } from "../state/event-store.js";
import type { ValidationError } from "../lib/config.js";
import type { UnreadTaskActivitySummary } from "../lib/task-activity.js";
import { useTheme } from "../lib/theme-context.js";
import { QueuedMessages } from "./queued-messages.js";
import { Sidebar, UsageSummaryLine } from "./sidebar.js";
import { StatusBar } from "./status-bar.js";
import { StreamingMessage } from "./streaming-message.js";
import { TodoBand } from "./todo-band.js";
import { ToastView } from "./toast.js";
import { SkillProposalCompletionCard } from "./skill-proposal-completion-card.js";
import { InlineDiagnostic } from "./inline-diagnostic.js";

export function LiveFrame(props: {
  state: StoreState;
  modelLabel: string;
  permissionMode: string;
  focused: boolean;
  runningTaskCount: number;
  unreadTasks: UnreadTaskActivitySummary;
  waitingWorkflowCount: number;
  streamingMax: number;
  sidebarWidth: number;
  columns: number;
  toast: React.ComponentProps<typeof ToastView>["toast"];
  toastQueueDepth: number;
  errors: ValidationError[];
  queued: readonly string[];
  showQueued: boolean;
  humanActionActive: boolean;
  onReviewHumanAction: (proposalId: string) => void;
  onApplyHumanAction: (proposalId: string) => Promise<boolean>;
  onDismissHumanAction: (proposalId: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  const showStatus =
    props.state.status === "running" ||
    props.state.status === "awaiting-approval" ||
    props.runningTaskCount > 0 ||
    props.unreadTasks.total > 0;
  const showWorkflowStatus = props.waitingWorkflowCount > 0;

  return (
    <>
      {showStatus || showWorkflowStatus ? (
        <StatusBar
          state={props.state}
          modelLabel={props.modelLabel}
          permissionMode={props.permissionMode}
          focused={props.focused}
          unreadTasks={props.unreadTasks}
          waitingWorkflowCount={props.waitingWorkflowCount}
        />
      ) : null}

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {props.state.streamingText || props.state.reasoningText ? (
            <StreamingMessage
              text={props.state.streamingText}
              reasoning={props.state.reasoningText}
              maxLines={props.streamingMax}
            />
          ) : null}
        </Box>
        {props.sidebarWidth > 0 ? (
          <Sidebar
            files={props.state.modifiedFiles}
            width={props.sidebarWidth}
          />
        ) : null}
      </Box>

      {props.state.todoItems.length > 0 &&
      (props.state.status === "running" ||
        props.state.status === "awaiting-approval" ||
        props.state.todoItems.some((t) => t.status !== "completed")) ? (
        <TodoBand
          todos={props.state.todoItems}
          width={props.columns}
          compact={Boolean(props.state.streamingText)}
        />
      ) : null}

      {props.state.status !== "running" &&
      props.state.status !== "awaiting-approval" &&
      props.state.usage ? (
        <UsageSummaryLine usage={props.state.usage} />
      ) : null}

      {props.state.lastDiagnostic ? (
        <InlineDiagnostic
          title={
            props.state.lastDiagnostic.scope === "RunFailure"
              ? "failure details"
              : props.state.lastDiagnostic.title
          }
          message={
            props.state.lastDiagnostic.scope === "ConnectionFailure"
              ? props.state.lastDiagnostic.message
              : undefined
          }
          hint="details /notifications · runtime evidence /events"
        />
      ) : null}

      <ToastView toast={props.toast} queueDepth={props.toastQueueDepth} />

      {props.state.pendingHumanAction &&
      props.state.status !== "running" &&
      props.state.status !== "awaiting-approval" ? (
        <SkillProposalCompletionCard
          action={props.state.pendingHumanAction}
          active={props.humanActionActive}
          onReview={props.onReviewHumanAction}
          onApply={props.onApplyHumanAction}
          onDismiss={props.onDismissHumanAction}
        />
      ) : null}

      {props.errors.length > 0 ? (
        <Box paddingX={1}>
          <Text color={theme.error} bold>
            config: {props.errors.length} validation error
            {props.errors.length === 1 ? "" : "s"}
          </Text>
          <Text color={theme.muted}> · /config for details</Text>
        </Box>
      ) : null}

      {props.showQueued ? <QueuedMessages items={props.queued} /> : null}
    </>
  );
}
