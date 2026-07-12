import React from "react";
import { Box, Text } from "ink";
import type { StoreState } from "../state/event-store.js";
import type { ValidationError } from "../lib/config.js";
import { useTheme } from "../lib/theme-context.js";
import { QueuedMessages } from "./queued-messages.js";
import { Sidebar, UsageSummaryLine } from "./sidebar.js";
import { StatusBar } from "./status-bar.js";
import { StreamingMessage } from "./streaming-message.js";
import { TodoBand } from "./todo-band.js";
import { ToastView } from "./toast.js";
import { HumanActionBand } from "./human-action-band.js";

export function LiveFrame(props: {
  state: StoreState;
  modelLabel: string;
  permissionMode: string;
  focused: boolean;
  runningTaskCount: number;
  unreadTaskCount: number;
  unreadFailedTaskCount: number;
  waitingWorkflowCount: number;
  streamingMax: number;
  sidebarWidth: number;
  columns: number;
  todoExpanded: boolean;
  toast: React.ComponentProps<typeof ToastView>["toast"];
  toastQueueDepth: number;
  errors: ValidationError[];
  queued: readonly string[];
  showQueued: boolean;
  confirmingHumanAction: boolean;
  applyingHumanAction: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const showStatus =
    props.state.status === "running" ||
    props.state.status === "awaiting-approval" ||
    props.runningTaskCount > 0 ||
    props.unreadTaskCount > 0;
  const showWorkflowStatus = props.waitingWorkflowCount > 0;

  return (
    <>
      {showStatus || showWorkflowStatus ? (
        <StatusBar
          state={props.state}
          modelLabel={props.modelLabel}
          permissionMode={props.permissionMode}
          focused={props.focused}
          unreadCompletedTasks={Math.max(
            0,
            props.unreadTaskCount - props.unreadFailedTaskCount,
          )}
          unreadFailedTasks={props.unreadFailedTaskCount}
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
          expanded={props.todoExpanded}
        />
      ) : null}

      {props.state.status !== "running" &&
      props.state.status !== "awaiting-approval" &&
      props.state.usage ? (
        <UsageSummaryLine usage={props.state.usage} />
      ) : null}

      {props.state.lastError ? (
        <Box paddingX={1}>
          <Text color={theme.error}>error: {props.state.lastError}</Text>
        </Box>
      ) : null}

      <ToastView toast={props.toast} queueDepth={props.toastQueueDepth} />

      {props.state.pendingHumanAction &&
      props.state.status !== "running" &&
      props.state.status !== "awaiting-approval" ? (
        <HumanActionBand
          action={props.state.pendingHumanAction}
          confirmingApply={props.confirmingHumanAction}
          applying={props.applyingHumanAction}
        />
      ) : null}

      {props.errors.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="red"
          paddingX={1}
        >
          <Text color="red" bold>
            config errors ({props.errors.length})
          </Text>
          {props.errors.map((error, i) => (
            <Text key={`${error.file}:${error.field}:${i}`}>
              <Text dimColor>{error.file}</Text>
              <Text> </Text>
              <Text color="red">{error.field}</Text>
              <Text> </Text>
              <Text>{error.message}</Text>
            </Text>
          ))}
        </Box>
      ) : null}

      {props.showQueued ? <QueuedMessages items={props.queued} /> : null}
    </>
  );
}
