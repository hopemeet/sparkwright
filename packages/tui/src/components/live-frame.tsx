import React, { useLayoutEffect, useRef } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";
import type { StoreState } from "../state/event-store.js";
import type { ValidationError } from "../lib/config.js";
import type { UnreadTaskActivitySummary } from "../lib/task-activity.js";
import type { QueuedSubmission } from "../state/queue-store.js";
import { useTheme } from "../lib/theme-context.js";
import { QueuedMessages } from "./queued-messages.js";
import { Sidebar, UsageSummaryLine } from "./sidebar.js";
import { StatusBar } from "./status-bar.js";
import { StreamingMessage } from "./streaming-message.js";
import { TodoBand } from "./todo-band.js";
import { ToastView } from "./toast.js";
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
  queued: readonly QueuedSubmission[];
  showQueued: boolean;
  onHeightChange?: (rows: number) => void;
}): React.ReactElement {
  const theme = useTheme();
  const frameRef = useRef<DOMElement | null>(null);
  const reportedHeightRef = useRef<number | null>(null);
  const showStatus =
    props.state.status === "running" ||
    props.state.status === "awaiting-approval" ||
    props.runningTaskCount > 0 ||
    props.unreadTasks.total > 0;
  const showWorkflowStatus = props.waitingWorkflowCount > 0;

  useLayoutEffect(() => {
    if (!frameRef.current) return;
    const height = measureElement(frameRef.current).height;
    if (reportedHeightRef.current === height) return;
    reportedHeightRef.current = height;
    props.onHeightChange?.(height);
  });

  return (
    <Box ref={frameRef} flexDirection="column" flexShrink={0}>
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
              maxRows={props.streamingMax}
              columns={Math.max(1, props.columns - props.sidebarWidth - 2)}
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
    </Box>
  );
}
