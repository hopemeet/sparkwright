import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../lib/theme-context.js";
import type {
  CreateCapabilityDraft,
  CreateCapabilityKind,
} from "../lib/create-capability.js";
import { DialogFrame } from "./dialog-frame.js";

const KINDS: CreateCapabilityKind[] = [
  "skill",
  "agent",
  "cron",
  "command",
  "mcp",
];

interface Field {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
}

const FIELDS: Record<CreateCapabilityKind, Field[]> = {
  skill: [
    { key: "name", label: "name", placeholder: "code-reviewer" },
    {
      key: "description",
      label: "description",
      placeholder: "review code changes for risk and clarity",
    },
  ],
  agent: [
    { key: "id", label: "id", placeholder: "reviewer" },
    {
      key: "prompt",
      label: "prompt",
      placeholder: "Review changes and report concrete risks.",
    },
    { key: "maxSteps", label: "max steps", placeholder: "4", optional: true },
    {
      key: "delegateToolName",
      label: "delegate tool",
      placeholder: "delegate_reviewer",
      optional: true,
    },
  ],
  cron: [
    {
      key: "name",
      label: "name",
      placeholder: "daily-summary",
      optional: true,
    },
    { key: "schedule", label: "schedule", placeholder: "every 1h" },
    {
      key: "prompt",
      label: "prompt",
      placeholder: "Summarize project status and open risks.",
    },
    {
      key: "skills",
      label: "skills",
      placeholder: "reporter,logs",
      optional: true,
    },
  ],
  command: [
    { key: "name", label: "name", placeholder: "summarize" },
    {
      key: "description",
      label: "description",
      placeholder: "summarize the current workspace",
    },
    {
      key: "prompt",
      label: "prompt",
      placeholder: "Summarize the current workspace. Args: $ARGUMENTS",
    },
  ],
  mcp: [
    { key: "name", label: "name", placeholder: "github" },
    { key: "serverType", label: "type", placeholder: "stdio or http" },
    {
      key: "commandOrUrl",
      label: "command/url",
      placeholder: "node",
    },
    {
      key: "args",
      label: "args",
      placeholder: "./tools/github-mcp.js --stdio",
      optional: true,
    },
  ],
};

export function CreateCapabilityDialog(props: {
  initialKind?: CreateCapabilityKind;
  onCancel: () => void;
  onCommit: (draft: CreateCapabilityDraft) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [kind, setKind] = useState<CreateCapabilityKind | null>(
    props.initialKind ?? null,
  );
  const [kindCursor, setKindCursor] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");

  const fields = useMemo(() => (kind ? FIELDS[kind] : []), [kind]);
  const field = fields[fieldIndex];

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }

    if (!kind) {
      if (key.upArrow) {
        setKindCursor((cursor) =>
          cursor <= 0 ? KINDS.length - 1 : cursor - 1,
        );
        return;
      }
      if (key.downArrow || key.tab) {
        setKindCursor((cursor) =>
          cursor >= KINDS.length - 1 ? 0 : cursor + 1,
        );
        return;
      }
      if (key.return) {
        setKind(KINDS[kindCursor]);
        return;
      }
      return;
    }

    if (field?.key === "serverType") {
      if (key.upArrow || key.downArrow || key.tab) {
        setValue((current) => (current.trim() === "http" ? "stdio" : "http"));
        return;
      }
    }

    if (key.return) {
      const nextValues = { ...values, [field.key]: value.trim() };
      if (fieldIndex < fields.length - 1) {
        setValues(nextValues);
        setFieldIndex((index) => index + 1);
        setValue("");
        return;
      }
      props.onCommit(buildDraft(kind, nextValues));
      return;
    }

    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) setValue((current) => current + input);
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        create capability
        <Text color={theme.muted}> enter next · esc cancel</Text>
      </Text>

      {!kind ? (
        <Box flexDirection="column" marginTop={1}>
          {KINDS.map((candidate, index) => (
            <Text
              key={candidate}
              color={index === kindCursor ? theme.accent : undefined}
              dimColor={index !== kindCursor}
            >
              {index === kindCursor ? "❯ " : "  "}
              {candidate}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={theme.success}>{kind}</Text>
            <Text color={theme.muted}>
              {" "}
              {fieldIndex + 1}/{fields.length}
            </Text>
          </Text>
          <Box>
            <Text color={theme.success}>
              {"› "}
              {field.label}:{" "}
            </Text>
            <Text>{value}</Text>
            <Text color={theme.accent}>▎</Text>
            {!value ? (
              <Text color={theme.muted}>{field.placeholder}</Text>
            ) : null}
          </Box>
          {field.optional ? (
            <Text color={theme.muted}>optional: press enter to skip</Text>
          ) : null}
          {field.key === "serverType" ? (
            <Text color={theme.muted}>tab toggles stdio/http</Text>
          ) : null}
        </Box>
      )}
    </DialogFrame>
  );
}

function buildDraft(
  kind: CreateCapabilityKind,
  values: Record<string, string>,
): CreateCapabilityDraft {
  switch (kind) {
    case "skill":
      return {
        kind,
        name: values.name ?? "",
        description: values.description ?? "",
      };
    case "agent":
      return {
        kind,
        id: values.id ?? "",
        prompt: values.prompt ?? "",
        ...(positiveInteger(values.maxSteps)
          ? { maxSteps: positiveInteger(values.maxSteps) }
          : {}),
        ...(values.delegateToolName
          ? { delegateToolName: values.delegateToolName }
          : {}),
      };
    case "cron":
      return {
        kind,
        ...(values.name ? { name: values.name } : {}),
        schedule: values.schedule ?? "",
        prompt: values.prompt ?? "",
        ...(values.skills ? { skills: splitCsv(values.skills) } : {}),
      };
    case "command":
      return {
        kind,
        name: values.name ?? "",
        description: values.description ?? "",
        prompt: values.prompt ?? "",
      };
    case "mcp": {
      const serverType = values.serverType === "http" ? "http" : "stdio";
      return {
        kind,
        name: values.name ?? "",
        serverType,
        commandOrUrl: values.commandOrUrl ?? "",
        ...(values.args ? { args: splitWords(values.args) } : {}),
      };
    }
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitWords(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
