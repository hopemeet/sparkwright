import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { PendingApproval } from "../state/event-store.js";
import { DiffView } from "./diff-view.js";
import { useTheme } from "../lib/theme-context.js";
import type { Theme } from "../lib/theme.js";
import {
  approvalChoiceLabel,
  approvalChoices,
  type ApprovalChoice,
} from "../lib/session-approval.js";
import {
  DialogFrame,
  dialogFrameWidth,
  resolveDialogColumns,
} from "./dialog-frame.js";

/**
 * Kind-aware approval panel. Shows a renderable body matching the action:
 *  - workspace.write  → unified diff with scroll keys
 *  - skill.apply      → final prepared Skill diff with scroll keys
 *  - tool.execute     → tool name + truncated args
 *  - shell.execute    → command (one-line) + reason
 *  - other            → summary + raw details
 *
 * Keys: up/down or j/k choose · Enter confirm · y approve once · n/Esc deny.
 * Long diffs use paging keys so vertical choice navigation stays intuitive.
 * Esc-to-deny is risk-averse on purpose: cancelling the *prompt* without
 * a decision would leave the run blocked forever, so we treat it as deny.
 */
export function ApprovalPrompt(props: {
  pending: PendingApproval;
  onDecision: (choice: ApprovalChoice) => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const theme = useTheme();
  const [scroll, setScroll] = useState(0);
  const [selected, setSelected] = useState(0);
  const choices = approvalChoices(props.pending.subject);
  // Reset scroll when the approval target changes — we keep this component
  // mounted across approvals when possible.
  useEffect(() => {
    setScroll(0);
    setSelected(0);
  }, [props.pending.id]);

  // Reserve some rows for header / footer / surrounding chrome. The remainder
  // is the diff viewport. Floor at 6 to stay useful on tiny terminals.
  const viewportRows = Math.max(6, (stdout?.rows ?? 30) - 18);
  const viewportCols = Math.max(
    20,
    dialogFrameWidth(resolveDialogColumns(stdout?.columns)) - 4,
  );

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      props.onDecision("allow-once");
      return;
    }
    if (input === "n" || input === "N" || key.escape) {
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
      props.onDecision(choices[selected] ?? "allow-once");
      return;
    }
    if (!props.pending.diff) return;
    if (key.pageDown || input === "d") setScroll((s) => s + viewportRows);
    else if (key.pageUp || input === "u")
      setScroll((s) => Math.max(0, s - viewportRows));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(1_000_000);
  });

  const borderColor = riskColor(props.pending.policy?.risk, theme);

  return (
    <DialogFrame borderColor={borderColor}>
      <Header pending={props.pending} theme={theme} />
      <Body
        pending={props.pending}
        theme={theme}
        scroll={scroll}
        viewportRows={viewportRows}
        viewportCols={viewportCols}
      />
      <Footer
        choices={choices}
        selected={selected}
        pending={props.pending}
        hasDiff={!!props.pending.diff}
        theme={theme}
      />
    </DialogFrame>
  );
}

function Header(props: {
  pending: PendingApproval;
  theme: Theme;
}): React.ReactElement {
  const { pending, theme } = props;
  const risk = pending.policy?.risk;
  const reason = pending.reason ?? pending.policy?.reason;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.warning} bold>
          ⚠ approval required
        </Text>
        <Text dimColor> {pending.action}</Text>
        {risk ? (
          <Text color={riskColor(risk, theme)}> · risk:{risk}</Text>
        ) : null}
      </Box>
      <Text>{pending.summary}</Text>
      {reason ? (
        <Text>
          <Text dimColor>reason: </Text>
          {reason}
        </Text>
      ) : null}
    </Box>
  );
}

function Body(props: {
  pending: PendingApproval;
  theme: Theme;
  scroll: number;
  viewportRows: number;
  viewportCols: number;
}): React.ReactElement | null {
  const { pending, theme } = props;

  if (
    (pending.kind === "workspace.write" || pending.kind === "skill.apply") &&
    pending.diff
  ) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>file: </Text>
          <Text color={theme.accent2}>{pending.path ?? "?"}</Text>
        </Text>
        {pending.kind === "skill.apply" ? (
          <Text dimColor>
            final prepared effect · approval is bound to this revision
          </Text>
        ) : null}
        <DiffView
          diff={pending.diff}
          scrollOffset={props.scroll}
          viewportRows={props.viewportRows}
          width={props.viewportCols}
        />
      </Box>
    );
  }

  if (pending.kind === "tool.execute") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>tool: </Text>
          <Text color={theme.accent}>{pending.toolName ?? "?"}</Text>
        </Text>
        <ToolArgs
          toolName={pending.toolName}
          args={pending.toolArgs}
          theme={theme}
          viewportCols={props.viewportCols}
        />
      </Box>
    );
  }

  if (pending.kind === "shell.execute" && pending.command) {
    return (
      <Box marginTop={1}>
        <Text dimColor>$ </Text>
        <Text color={theme.accent2}>
          {truncateText(pending.command, props.viewportCols - 2)}
        </Text>
      </Box>
    );
  }

  return pending.path ? (
    <Box marginTop={1}>
      <Text dimColor>path: </Text>
      <Text>{pending.path}</Text>
    </Box>
  ) : null;
}

function Footer(props: {
  choices: readonly ApprovalChoice[];
  selected: number;
  pending: PendingApproval;
  hasDiff: boolean;
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
      <Text dimColor>↑/↓ choose · enter confirm · y once · n/esc deny</Text>
      {props.hasDiff ? (
        <Text dimColor>pgup/pgdn or u/d review diff · g/G top/bottom</Text>
      ) : null}
    </Box>
  );
}

function ToolArgs(props: {
  toolName?: string;
  args: unknown;
  theme: Theme;
  viewportCols: number;
}): React.ReactElement | null {
  const args = rec(props.args);
  if (
    args &&
    (props.toolName === "create_skill" || props.toolName === "update_skill")
  ) {
    return (
      <SkillToolArgs
        toolName={props.toolName}
        args={args}
        theme={props.theme}
      />
    );
  }
  if (args && isShellToolName(props.toolName)) {
    return (
      <ShellToolArgs
        args={args}
        theme={props.theme}
        viewportCols={props.viewportCols}
      />
    );
  }
  if (!props.args) return null;
  return (
    <Text>
      <Text dimColor>args: </Text>
      <Text>{truncateJson(props.args, props.viewportCols)}</Text>
    </Text>
  );
}

function isShellToolName(name: string | undefined): boolean {
  return name === "bash" || name === "shell";
}

function ShellToolArgs(props: {
  args: Record<string, unknown>;
  theme: Theme;
  viewportCols: number;
}): React.ReactElement {
  const command = str(props.args.command) || "?";
  const cwd = str(props.args.cwd);
  const timeoutMs =
    typeof props.args.timeoutMs === "number" ? props.args.timeoutMs : undefined;
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>$ </Text>
        <Text color={props.theme.accent2}>
          {truncateText(command, props.viewportCols - 2)}
        </Text>
      </Text>
      {cwd ? (
        <Text>
          <Text dimColor>cwd: </Text>
          {truncateText(cwd, props.viewportCols - 5)}
        </Text>
      ) : null}
      {timeoutMs !== undefined ? (
        <Text>
          <Text dimColor>timeout: </Text>
          {timeoutMs}ms
        </Text>
      ) : null}
    </Box>
  );
}

function SkillToolArgs(props: {
  toolName: "create_skill" | "update_skill";
  args: Record<string, unknown>;
  theme: Theme;
}): React.ReactElement {
  const action = str(props.args.action) || "?";
  const name = str(props.args.name) || "?";
  const root = str(props.args.root);
  const force = props.args.force === true;
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>skill: </Text>
        <Text color={props.theme.accent2}>{name}</Text>
      </Text>
      <Text>
        <Text dimColor>action: </Text>
        {action}
        {force ? <Text color={props.theme.warning}> · force</Text> : null}
      </Text>
      {root ? (
        <Text>
          <Text dimColor>root: </Text>
          {root}
        </Text>
      ) : null}
      <Text dimColor>{skillEffect(props.toolName, action, name)}</Text>
    </Box>
  );
}

function skillEffect(
  toolName: "create_skill" | "update_skill",
  action: string,
  name: string,
): string {
  if (toolName === "create_skill") {
    return `effect: draft proposal for .sparkwright/skills/${name}; current Skill package is unchanged`;
  }
  if (action === "draft") {
    return "effect: draft proposal only; original Skill package is unchanged";
  }
  if (action === "apply") {
    return "effect: apply an existing proposal to the Skill package";
  }
  return "effect: update Skill package through the managed Skill tool";
}

function riskColor(risk: string | undefined, theme: Theme): string {
  if (risk === "risky" || risk === "high") return theme.error;
  return theme.warning;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateJson(value: unknown, maxCols: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return truncateText(text, maxCols);
}

function truncateText(text: string, maxCols: number): string {
  if (text.length <= maxCols) return text;
  return text.slice(0, Math.max(0, maxCols - 1)) + "…";
}
