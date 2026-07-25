import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { ApprovalViewModel } from "../lib/approval-view-model.js";
import { defaultApprovalChoice } from "../lib/approval-view-model.js";
import {
  approvalChoiceLabel,
  approvalChoices,
  type ApprovalChoice,
} from "../lib/session-approval.js";
import { useTheme } from "../lib/theme-context.js";
import type { Theme } from "../lib/theme.js";
import { DiffView } from "./diff-view.js";
import {
  DialogFrame,
  dialogFrameWidth,
  resolveDialogColumns,
} from "./dialog-frame.js";
import { KeyHints } from "./key-hints.js";

/** Blocking decision surface. Esc and Ctrl+C are explicit Deny decisions. */
export function ApprovalPrompt(props: {
  pending: ApprovalViewModel;
  onDecision: (choice: ApprovalChoice) => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const theme = useTheme();
  const [scroll, setScroll] = useState(0);
  const choices = approvalChoices(props.pending.subject);
  const defaultChoice = defaultApprovalChoice(props.pending);
  const defaultIndex = Math.max(0, choices.indexOf(defaultChoice));
  const [selected, setSelected] = useState(defaultIndex);
  const viewportRows = Math.max(5, (stdout?.rows ?? 30) - 21);
  const viewportCols = Math.max(
    20,
    dialogFrameWidth(resolveDialogColumns(stdout?.columns)) - 4,
  );

  useEffect(() => {
    setScroll(0);
    setSelected(defaultIndex);
  }, [props.pending.approvalId, defaultIndex]);

  useInput((input, key) => {
    if (props.pending.resolving) return;
    if (input === "y" || input === "Y") {
      props.onDecision("allow-once");
      return;
    }
    if ((input === "s" || input === "S") && choices.includes("allow-session")) {
      props.onDecision("allow-session");
      return;
    }
    if (
      input === "n" ||
      input === "N" ||
      key.escape ||
      (key.ctrl && input === "c") ||
      input.includes("\x03")
    ) {
      props.onDecision("deny");
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((value) => (value - 1 + choices.length) % choices.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((value) => (value + 1) % choices.length);
      return;
    }
    if (key.return) {
      props.onDecision(choices[selected] ?? defaultChoice);
      return;
    }
    if (key.pageDown || input === "d") setScroll((s) => s + viewportRows);
    else if (key.pageUp || input === "u")
      setScroll((s) => Math.max(0, s - viewportRows));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(1_000_000);
  });

  return (
    <DecisionShell borderColor={riskColor(props.pending.risk, theme)}>
      <DecisionHeader pending={props.pending} theme={theme} />
      <ExecutionOrigin pending={props.pending} theme={theme} />
      <EffectSummary pending={props.pending} />
      <PolicyExplanation pending={props.pending} theme={theme} />
      <DecisionScope pending={props.pending} theme={theme} />
      <DecisionBody
        pending={props.pending}
        theme={theme}
        scroll={scroll}
        viewportRows={viewportRows}
        viewportCols={viewportCols}
      />
      <DecisionActions
        choices={choices}
        selected={selected}
        pending={props.pending}
        theme={theme}
      />
      <DecisionProgress pending={props.pending} theme={theme} />
    </DecisionShell>
  );
}

export function DecisionShell(props: {
  borderColor: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <DialogFrame borderColor={props.borderColor}>{props.children}</DialogFrame>
  );
}

export function DecisionHeader(props: {
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement {
  return (
    <Box>
      <Text color={props.theme.warning} bold>
        ⚠ approval required
      </Text>
      <Text dimColor> · {props.pending.action}</Text>
      <Text color={riskColor(props.pending.risk, props.theme)}>
        {` · risk:${props.pending.risk}`}
      </Text>
      <Box flexGrow={1} />
      <Text dimColor>
        {props.pending.queuePosition} of {props.pending.queueDepth}
      </Text>
    </Box>
  );
}

export function ExecutionOrigin(props: {
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement {
  const pending = props.pending;
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>origin: </Text>
        <Text color={props.theme.accent}>
          {pending.principalLabel ?? principalKindLabel(pending.principalKind)}
        </Text>
        <Text dimColor> ({pending.principalKind})</Text>
      </Text>
      <Text dimColor>
        run {pending.runId} · scope {pending.principalScope} · session{" "}
        {pending.sessionId}
        {pending.executionKind === "workflow"
          ? ` · workflow ${pending.workflowId ?? "execution"}`
          : ""}
      </Text>
    </Box>
  );
}

export function EffectSummary(props: {
  pending: ApprovalViewModel;
}): React.ReactElement {
  return <Text bold>{props.pending.summary}</Text>;
}

export function PolicyExplanation(props: {
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement | null {
  const rows = [
    ["policy", props.pending.policyReason ?? props.pending.reason],
    ["tool", props.pending.toolReason],
    ["safety", props.pending.safetyReason],
  ].filter((row): row is [string, string] => typeof row[1] === "string");
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column">
      {rows.map(([layer, reason]) => (
        <Text key={layer}>
          <Text dimColor>{layer}: </Text>
          <Text color={props.theme.warning}>{reason}</Text>
        </Text>
      ))}
    </Box>
  );
}

function principalKindLabel(kind: ApprovalViewModel["principalKind"]): string {
  if (kind === "dynamic_child") return "dynamic child";
  if (kind === "configured_delegate") return "configured delegate";
  return "main";
}

export function DecisionScope(props: {
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement {
  return (
    <Text>
      <Text dimColor>scope: </Text>
      <Text color={props.theme.accent2}>{props.pending.exactScope}</Text>
    </Text>
  );
}

function DecisionBody(props: {
  pending: ApprovalViewModel;
  theme: Theme;
  scroll: number;
  viewportRows: number;
  viewportCols: number;
}): React.ReactElement {
  switch (props.pending.kind) {
    case "workspace.write":
      return <WorkspaceWriteDecision {...props} />;
    case "shell.execute":
      return <ShellDecision {...props} />;
    case "tool.execute":
      return <ToolDecision {...props} />;
    case "skill.apply":
      return <SkillApplyDecision {...props} />;
    default:
      return <UnknownDecision {...props} />;
  }
}

export function WorkspaceWriteDecision(
  props: DecisionBodyProps,
): React.ReactElement {
  return <DiffDecision {...props} label="workspace write" />;
}

export function SkillApplyDecision(
  props: DecisionBodyProps,
): React.ReactElement {
  return <DiffDecision {...props} label="final prepared Skill effect" />;
}

interface DecisionBodyProps {
  pending: ApprovalViewModel;
  theme: Theme;
  scroll: number;
  viewportRows: number;
  viewportCols: number;
}

function DiffDecision(
  props: DecisionBodyProps & { label: string },
): React.ReactElement {
  const summary = props.pending.diffSummary;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{props.label}</Text>
      <Text>
        <Text dimColor>target: </Text>
        <Text color={props.theme.accent2}>{props.pending.path ?? "?"}</Text>
      </Text>
      {summary ? (
        <Text dimColor>
          {summary.files.length} file{summary.files.length === 1 ? "" : "s"}
          {` · +${summary.additions} -${summary.deletions}`}
          {summary.files.length > 0 ? ` · ${summary.files.join(", ")}` : ""}
        </Text>
      ) : null}
      {props.pending.diff ? (
        <DiffView
          diff={props.pending.diff}
          scrollOffset={props.scroll}
          viewportRows={props.viewportRows}
          width={props.viewportCols}
        />
      ) : (
        <Text color={props.theme.warning}>No diff was supplied.</Text>
      )}
    </Box>
  );
}

export function ShellDecision(props: DecisionBodyProps): React.ReactElement {
  const command =
    props.pending.command ??
    stringValue(props.pending.toolArgs, "command") ??
    "?";
  const cwd =
    props.pending.cwd ?? stringValue(props.pending.toolArgs, "cwd") ?? "?";
  const lines = useMemo(
    () => wrapDetailLines(`$ ${command}\ncwd: ${cwd}`, props.viewportCols),
    [command, cwd, props.viewportCols],
  );
  return (
    <DetailLines
      title="shell command"
      lines={lines}
      scroll={props.scroll}
      viewportRows={props.viewportRows}
      theme={props.theme}
    />
  );
}

export function ToolDecision(props: DecisionBodyProps): React.ReactElement {
  const json = safePrettyJson(props.pending.toolArgs);
  const lines = useMemo(
    () => wrapDetailLines(json, props.viewportCols),
    [json, props.viewportCols],
  );
  return (
    <DetailLines
      title={`tool ${props.pending.toolName ?? "?"} arguments`}
      lines={lines}
      scroll={props.scroll}
      viewportRows={props.viewportRows}
      theme={props.theme}
    />
  );
}

export function UnknownDecision(props: DecisionBodyProps): React.ReactElement {
  const json = safePrettyJson(props.pending.details);
  const lines = useMemo(
    () => wrapDetailLines(json, props.viewportCols),
    [json, props.viewportCols],
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={props.theme.error} bold>
        Unknown approval shape — fail closed; session approval is unavailable.
      </Text>
      <DetailLines
        title="host details"
        lines={lines}
        scroll={props.scroll}
        viewportRows={props.viewportRows}
        theme={props.theme}
      />
    </Box>
  );
}

function DetailLines(props: {
  title: string;
  lines: readonly string[];
  scroll: number;
  viewportRows: number;
  theme: Theme;
}): React.ReactElement {
  const maxScroll = Math.max(0, props.lines.length - props.viewportRows);
  const start = Math.min(props.scroll, maxScroll);
  const visible = props.lines.slice(start, start + props.viewportRows);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{props.title}</Text>
      {visible.map((line, index) => (
        <Text key={`${start + index}:${line}`} color={props.theme.accent2}>
          {line || " "}
        </Text>
      ))}
      {props.lines.length > props.viewportRows ? (
        <Text dimColor>
          lines {start + 1}-
          {Math.min(props.lines.length, start + visible.length)} of{" "}
          {props.lines.length}
        </Text>
      ) : null}
    </Box>
  );
}

export function DecisionActions(props: {
  choices: readonly ApprovalChoice[];
  selected: number;
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.choices.map((choice, index) => (
        <Text
          key={choice}
          color={index === props.selected ? props.theme.accent : undefined}
          bold={index === props.selected}
        >
          {index === props.selected ? "› " : "  "}
          {approvalChoiceLabel(choice, props.pending.subject)}
        </Text>
      ))}
      <KeyHints
        hints={[
          { keys: "↑/↓", label: "choose" },
          { keys: "enter", label: "confirm" },
          { keys: "y", label: "once" },
          ...(props.choices.includes("allow-session")
            ? [{ keys: "s", label: "session" }]
            : []),
          { keys: "n/esc", label: "deny" },
          { keys: "pgup/pgdn", label: "details" },
        ]}
      />
    </Box>
  );
}

export function DecisionProgress(props: {
  pending: ApprovalViewModel;
  theme: Theme;
}): React.ReactElement | null {
  if (props.pending.resolving) {
    return (
      <Text color={props.theme.warning}>
        resolving {props.pending.submittedChoice ?? "decision"}… duplicate input
        disabled
      </Text>
    );
  }
  if (props.pending.error) {
    return (
      <Text color={props.theme.error}>
        resolve failed: {props.pending.error}
      </Text>
    );
  }
  return null;
}

function riskColor(risk: ApprovalViewModel["risk"], theme: Theme): string {
  return risk === "high" || risk === "unknown" ? theme.error : theme.warning;
}

function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : undefined;
}

function wrapDetailLines(text: string, width: number): string[] {
  const safeWidth = Math.max(12, width);
  const lines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < sourceLine.length; offset += safeWidth) {
      lines.push(sourceLine.slice(offset, offset + safeWidth));
    }
  }
  return lines;
}
