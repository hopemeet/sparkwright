import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../lib/theme-context.js";
import type {
  TuiSkillReviewDetail,
  TuiSkillReviewItem,
} from "../lib/skill-evolution.js";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import { DialogFrame } from "./dialog-frame.js";

type ReviewTab = "proposal" | "patch" | "metadata";

const TABS: ReviewTab[] = ["proposal", "patch", "metadata"];

export function SkillReviewDialog(props: {
  review: TuiSkillReviewDetail | null;
  loading: boolean;
  workspaceRoot?: string;
  onApply: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [tabIndex, setTabIndex] = useState(0);
  const [pendingAction, setPendingAction] = useState<"apply" | "reject" | null>(
    null,
  );
  const items = props.review?.items ?? [];
  const safeCursor =
    items.length === 0 ? 0 : Math.min(cursor, items.length - 1);
  const selected = items[safeCursor];
  const tab = TABS[tabIndex];
  const visibleStart = Math.max(
    0,
    Math.min(Math.max(0, safeCursor - 4), Math.max(0, items.length - 10)),
  );
  const visibleItems = items.slice(visibleStart, visibleStart + 10);

  useInput((input, key) => {
    if (pendingAction) {
      if (key.escape) {
        setPendingAction(null);
        return;
      }
      if (key.return && selected) {
        if (pendingAction === "apply") props.onApply(selected.id);
        else props.onReject(selected.id);
        setPendingAction(null);
        return;
      }
      return;
    }

    if (key.escape || input === "q") {
      props.onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (key.tab || input === "l") {
      setTabIndex((current) => (current + 1) % TABS.length);
      return;
    }
    if (input === "h") {
      setTabIndex((current) => (current <= 0 ? TABS.length - 1 : current - 1));
      return;
    }
    if (input === "a" && selected) {
      setPendingAction("apply");
      return;
    }
    if (input === "r" && selected) {
      setPendingAction("reject");
    }
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        skill review
        <Text color={theme.muted}>
          {" "}
          up/down select | tab view | a apply | r reject | q/esc close
        </Text>
      </Text>
      {props.loading ? <Text color={theme.muted}>loading...</Text> : null}
      {!props.loading && !props.review ? (
        <Text color={theme.muted}>no proposal snapshot available</Text>
      ) : null}
      {props.review ? (
        <>
          <Text color={theme.muted}>
            {props.review.total} proposal(s)
            {props.review.stateFilter
              ? ` filtered:${props.review.stateFilter}`
              : ""}
            {props.review.total > items.length
              ? ` showing:${items.length}`
              : ""}
          </Text>
          {items.length === 0 ? (
            <Text color={theme.muted}>no proposals</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {visibleItems.map((proposal, index) => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  selected={visibleStart + index === safeCursor}
                />
              ))}
            </Box>
          )}
          {selected ? (
            <Box flexDirection="column" marginTop={1}>
              {pendingAction ? (
                <Text
                  color={
                    pendingAction === "apply" ? theme.warning : theme.error
                  }
                >
                  confirm {pendingAction} {selected.id}: enter confirm | esc
                  cancel
                </Text>
              ) : null}
              <TabBar active={tab} />
              <DetailLines
                proposal={selected}
                tab={tab}
                workspaceRoot={props.workspaceRoot}
              />
            </Box>
          ) : null}
        </>
      ) : null}
    </DialogFrame>
  );
}

function ProposalRow(props: {
  proposal: TuiSkillReviewItem;
  selected: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const p = props.proposal;
  return (
    <Text color={props.selected ? theme.success : undefined}>
      {props.selected ? "> " : "  "}
      <Text color={stateColor(p.state)}>{p.state}</Text> {p.kind} {p.skillName}
      {contentModeLabel(p) ? (
        <Text color={theme.warning}> {contentModeLabel(p)}</Text>
      ) : null}
      <Text color={theme.muted}> {p.id}</Text>
    </Text>
  );
}

function TabBar(props: { active: ReviewTab }): React.ReactElement {
  const theme = useTheme();
  return (
    <Text>
      {TABS.map((tab, index) => (
        <React.Fragment key={tab}>
          <Text color={tab === props.active ? theme.accent : theme.muted}>
            {tab === props.active ? `[${tab}]` : tab}
          </Text>
          {index < TABS.length - 1 ? (
            <Text color={theme.muted}> | </Text>
          ) : null}
        </React.Fragment>
      ))}
    </Text>
  );
}

function DetailLines(props: {
  proposal: TuiSkillReviewItem;
  tab: ReviewTab;
  workspaceRoot?: string;
}): React.ReactElement {
  const theme = useTheme();
  const text = detailText(props.proposal, props.tab, props.workspaceRoot);
  const lines = text.split("\n").slice(0, 18);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`${props.tab}-${index}`} color={lineColor(line, theme)}>
          {line.length > 110 ? `${line.slice(0, 107)}...` : line}
        </Text>
      ))}
      {text.split("\n").length > lines.length ? (
        <Text color={theme.muted}>... truncated</Text>
      ) : null}
    </Box>
  );
}

function detailText(
  proposal: TuiSkillReviewItem,
  tab: ReviewTab,
  workspaceRoot?: string,
): string {
  switch (tab) {
    case "patch":
      return proposal.patchDiff || "(empty patch)";
    case "metadata":
      return JSON.stringify(
        {
          id: proposal.id,
          state: proposal.state,
          kind: proposal.kind,
          skillName: proposal.skillName,
          targetPath: displayProposalPath(proposal.targetPath, workspaceRoot),
          basePackageHash: proposal.basePackageHash,
          afterPackageHash: proposal.afterPackageHash,
          contentMode: proposal.contentMode,
          sourceLayer: proposal.sourceLayer,
          sourcePath: displayProposalPath(proposal.sourcePath, workspaceRoot),
          createdAt: proposal.createdAt,
          updatedAt: proposal.updatedAt,
          closedAt: proposal.closedAt,
          statusReason: proposal.statusReason,
          supersededBy: proposal.supersededBy,
        },
        null,
        2,
      );
    case "proposal":
    default:
      return [
        proposalContentNotice(proposal),
        proposal.proposalMarkdown || "(empty proposal)",
      ]
        .filter(Boolean)
        .join("\n\n");
  }
}

function proposalContentNotice(proposal: TuiSkillReviewItem): string {
  switch (proposal.contentMode) {
    case "intent_stub":
      return "content: intent-only update stub; review needs real authored SKILL.md before apply";
    case "template":
      return "content: generated create template; review needs real authored SKILL.md before apply";
    default:
      return "";
  }
}

function contentModeLabel(proposal: TuiSkillReviewItem): string {
  switch (proposal.contentMode) {
    case "intent_stub":
      return "[intent-only]";
    case "template":
      return "[template]";
    default:
      return "";
  }
}

function displayProposalPath(
  path: string | undefined,
  workspaceRoot: string | undefined,
): string | undefined {
  return path
    ? formatWorkspaceDisplayPath(path, { workspaceRoot, maxCols: 96 })
    : undefined;
}

function stateColor(state: string): string {
  switch (state) {
    case "applied":
      return "green";
    case "failed":
    case "stale":
      return "red";
    case "rejected":
    case "superseded":
      return "yellow";
    case "draft":
    default:
      return "cyan";
  }
}

function lineColor(
  line: string,
  theme: ReturnType<typeof useTheme>,
): string | undefined {
  if (line.startsWith("+")) return theme.diffAdded;
  if (line.startsWith("-")) return theme.diffRemoved;
  if (line.startsWith("@@")) return theme.diffHunk;
  return undefined;
}
