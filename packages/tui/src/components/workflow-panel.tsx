import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import { DialogFrame } from "./dialog-frame.js";
import {
  latestWorkflowVerdict,
  shortWorkflowId,
} from "../lib/workflow-display.js";

export function WorkflowPanel(props: {
  workflows: readonly WorkflowRunSnapshot[];
  selectedWorkflowId?: string;
  loading: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);
  const selectedIndex = Math.max(
    0,
    props.workflows.findIndex((item) => item.id === props.selectedWorkflowId),
  );
  const effectiveCursor = props.selectedWorkflowId ? selectedIndex : cursor;
  const selected = props.workflows[effectiveCursor];
  const viewport = Math.max(6, (stdout?.rows ?? 30) - 13);
  const listWindow = useMemo(() => {
    const start = Math.max(0, effectiveCursor - Math.floor(viewport / 2));
    return props.workflows.slice(start, start + viewport).map((item, i) => ({
      item,
      index: start + i,
    }));
  }, [props.workflows, effectiveCursor, viewport]);

  useInput((input, key) => {
    if (key.escape || input === "q") return props.onClose();
    if (input === "r") return props.onRefresh();
    if (key.downArrow || input === "j") {
      if (props.workflows.length === 0) return;
      setCursor((value) => Math.min(props.workflows.length - 1, value + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      if (props.workflows.length === 0) return;
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.return && selected) props.onSelect(selected.id);
  });

  return (
    <DialogFrame borderColor="cyan">
      <Text color="cyan" bold>
        workflow jobs{props.loading ? " · refreshing" : ""}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {props.workflows.length === 0 ? (
          <Text dimColor>no workflow jobs found</Text>
        ) : (
          listWindow.map(({ item, index }) => (
            <WorkflowRow
              key={item.id}
              workflow={item}
              selected={index === effectiveCursor}
            />
          ))
        )}
      </Box>
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selected.assetName}</Text>
          <Text>
            <Text dimColor>id </Text>
            {selected.id}
          </Text>
          <Text>
            <Text dimColor>status </Text>
            {selected.status}
            {selected.activeRunId ? (
              <Text dimColor> · active {selected.activeRunId}</Text>
            ) : null}
          </Text>
          <Text>
            <Text dimColor>current node </Text>
            {selected.currentNodeId ?? "-"}
          </Text>
          <Text>
            <Text dimColor>latest verdict </Text>
            {latestWorkflowVerdict(selected) ?? "-"}
          </Text>
          <Text>
            <Text dimColor>wait </Text>
            {selected.wait
              ? `${selected.wait.kind}${selected.wait.reason ? ` · ${selected.wait.reason}` : ""}`
              : "-"}
          </Text>
          <Text>
            <Text dimColor>failure </Text>
            {selected.failure
              ? `${selected.failure.kind}:${selected.failure.code} · ${selected.failure.message}`
              : "-"}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>esc close · r refresh · ↑/↓ j/k · enter attach</Text>
      </Box>
    </DialogFrame>
  );
}

function WorkflowRow(props: {
  workflow: WorkflowRunSnapshot;
  selected: boolean;
}): React.ReactElement {
  const workflow = props.workflow;
  const wait = workflow.wait ? ` · wait:${workflow.wait.kind}` : "";
  const node = workflow.currentNodeId ? ` · ${workflow.currentNodeId}` : "";
  const failure = workflow.failure ? ` · ${workflow.failure.code}` : "";
  const marker = props.selected ? "›" : " ";
  const color =
    workflow.status === "failed" || workflow.status === "cancelled"
      ? "red"
      : workflow.status === "waiting"
        ? "yellow"
        : workflow.status === "completed"
          ? "green"
          : "cyan";
  return (
    <Box>
      <Text color={props.selected ? "cyan" : undefined}>{marker} </Text>
      <Text color={color}>{workflow.status.padEnd(9)}</Text>
      <Text> {shortWorkflowId(workflow.id)}</Text>
      <Text dimColor>
        {" "}
        {workflow.assetName}
        {node}
        {wait}
        {failure}
      </Text>
    </Box>
  );
}
