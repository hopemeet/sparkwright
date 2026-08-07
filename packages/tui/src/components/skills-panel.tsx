import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type {
  TuiSkillBrowserEntry,
  TuiSkillsBrowserSnapshot,
} from "../lib/skills-browser.js";
import { isBackInput } from "../lib/input-key.js";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

export function SkillsPanel(props: {
  snapshot: TuiSkillsBrowserSnapshot | null;
  loading: boolean;
  workspaceRoot?: string;
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const skills = props.snapshot?.skills ?? [];
  const effectiveCursor = Math.min(cursor, Math.max(0, skills.length - 1));
  const selected = skills[effectiveCursor];
  const pageSize = Math.max(4, (stdout?.rows ?? 30) - 11);
  const visible = useMemo(
    () => skillWindow(skills, effectiveCursor, pageSize),
    [skills, effectiveCursor, pageSize],
  );

  useEffect(() => {
    setCursor(0);
    setShowDetail(false);
  }, [props.snapshot]);

  useInput((input, key) => {
    if (isBackInput(input, key)) {
      if (showDetail) setShowDetail(false);
      else props.onClose();
      return;
    }
    if (showDetail) return;
    if (key.downArrow || input === "j") {
      if (skills.length === 0) return;
      setCursor((value) => Math.min(skills.length - 1, value + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.return && selected) setShowDetail(true);
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        {skillsTitle(props.snapshot, props.loading)}
      </Text>
      {props.loading ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>loading inventory and recent usage…</Text>
        </Box>
      ) : showDetail && selected ? (
        <SkillDetail skill={selected} workspaceRoot={props.workspaceRoot} />
      ) : (
        <SkillList
          snapshot={props.snapshot}
          visible={visible}
          selectedIndex={effectiveCursor}
        />
      )}
    </DialogFrame>
  );
}

function SkillList(props: {
  snapshot: TuiSkillsBrowserSnapshot | null;
  visible: Array<{ skill: TuiSkillBrowserEntry; index: number }>;
  selectedIndex: number;
}): React.ReactElement {
  const theme = useTheme();
  const skills = props.snapshot?.skills ?? [];
  return (
    <Box flexDirection="column" marginTop={1}>
      {!props.snapshot ? (
        <Text color={theme.muted}>Skill data unavailable</Text>
      ) : skills.length === 0 ? (
        <Text color={theme.muted}>no Skills found</Text>
      ) : (
        props.visible.map(({ skill, index }) => (
          <SkillRow
            key={`${skill.name}:${skill.layer}:${skill.packageHash}`}
            skill={skill}
            selected={index === props.selectedIndex}
          />
        ))
      )}
      {props.snapshot?.inventoryIssueCount ? (
        <Text color={theme.warning}>
          {countLabel(props.snapshot.inventoryIssueCount, "inventory issue")}
        </Text>
      ) : null}
      {props.snapshot?.traceIssueCount ? (
        <Text color={theme.warning}>
          recent usage is incomplete ·{" "}
          {countLabel(props.snapshot.traceIssueCount, "trace issue")}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {skills.length > 0
            ? "↑/↓ j/k select · enter details · esc close"
            : "esc close"}
        </Text>
      </Box>
    </Box>
  );
}

function SkillRow(props: {
  skill: TuiSkillBrowserEntry;
  selected: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const marker = props.selected ? "›" : " ";
  return (
    <Box>
      <Text color={props.selected ? theme.accent : undefined}>
        {marker} {truncateName(props.skill.name).padEnd(32)}
      </Text>
      <Text color={theme.muted}>{props.skill.layer.padEnd(11)}</Text>
      <Text>{countLabel(props.skill.loadedCount, "load")}</Text>
    </Box>
  );
}

function SkillDetail(props: {
  skill: TuiSkillBrowserEntry;
  workspaceRoot?: string;
}): React.ReactElement {
  const theme = useTheme();
  const skill = props.skill;
  const source = skill.sourcePath
    ? formatWorkspaceDisplayPath(skill.sourcePath, {
        workspaceRoot: props.workspaceRoot,
        maxCols: 72,
      })
    : "—";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {skill.name} <Text color={theme.muted}>· {skill.layer}</Text>
      </Text>
      <Text color={theme.muted}>{skill.description}</Text>
      <Box marginTop={1} flexDirection="column">
        <DetailRow
          label="Loads"
          value={`${skill.loadedCount} · explicit ${skill.explicitLoadCount} · resident ${skill.residentLoadCount}`}
        />
        <DetailRow
          label="Load failures"
          value={String(skill.loadFailureCount)}
        />
        <DetailRow
          label="Associated runs"
          value={`${skill.associatedRuns.completed} completed · ${skill.associatedRuns.failed} failed · ${skill.associatedRuns.cancelled} cancelled`}
        />
        <DetailRow
          label="Related tool failures"
          value={`${skill.relatedToolFailures.unresolved} unresolved · ${skill.relatedToolFailures.total} total`}
        />
        <DetailRow label="Source" value={source} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>
          Related run and tool results are signals, not proof that the Skill
          caused them.
        </Text>
        <Text color={theme.muted}>esc back</Text>
      </Box>
    </Box>
  );
}

function DetailRow(props: {
  label: string;
  value: string;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <Text>
      <Text color={theme.muted}>{props.label.padEnd(22)}</Text>
      {props.value}
    </Text>
  );
}

function skillsTitle(
  snapshot: TuiSkillsBrowserSnapshot | null,
  loading: boolean,
): string {
  if (loading) return "Skills · loading";
  if (!snapshot) return "Skills";
  return `Skills · ${snapshot.skills.length} available · ${snapshot.sessionsScanned} sessions scanned`;
}

function skillWindow(
  skills: readonly TuiSkillBrowserEntry[],
  cursor: number,
  pageSize: number,
): Array<{ skill: TuiSkillBrowserEntry; index: number }> {
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(pageSize / 2), skills.length - pageSize),
  );
  return skills.slice(start, start + pageSize).map((skill, offset) => ({
    skill,
    index: start + offset,
  }));
}

function truncateName(name: string): string {
  return name.length <= 31 ? name : `${name.slice(0, 30)}…`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
