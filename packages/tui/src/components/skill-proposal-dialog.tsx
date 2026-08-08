import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../lib/theme-context.js";
import type { TuiSkillProposalInput } from "../lib/skill-evolution.js";
import { DialogFrame } from "./dialog-frame.js";

type FieldKey = "name" | "description";

interface Field {
  key: FieldKey;
  label: string;
  placeholder: string;
}

const FIELDS: Field[] = [
  { key: "name", label: "name", placeholder: "code-reviewer" },
  {
    key: "description",
    label: "description",
    placeholder: "Reviews code changes for risk and missing tests.",
  },
];

export function SkillProposalDialog(props: {
  initialName?: string;
  onCancel: () => void;
  onCommit: (draft: TuiSkillProposalInput) => void;
}): React.ReactElement {
  const theme = useTheme();
  const initialFieldIndex = props.initialName ? 1 : 0;
  const [fieldIndex, setFieldIndex] = useState(initialFieldIndex);
  const [values, setValues] = useState<Record<FieldKey, string>>({
    name: props.initialName ?? "",
    description: "",
  });
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const field = FIELDS[fieldIndex];

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }

    if (key.return) {
      const nextValues = {
        ...values,
        [field.key]: value.trim(),
      };
      const validation = validateField(field.key, nextValues[field.key]);
      if (validation) {
        setError(validation);
        return;
      }
      setError(null);

      if (fieldIndex < FIELDS.length - 1) {
        const nextField = FIELDS[fieldIndex + 1];
        setValues(nextValues);
        setFieldIndex((index) => index + 1);
        const nextValue = nextValues[nextField.key] ?? "";
        setValue(nextValue);
        setCursor(nextValue.length);
        return;
      }

      props.onCommit({
        name: nextValues.name,
        description: nextValues.description,
      });
      return;
    }

    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((current) => Math.min(value.length, current + 1));
      return;
    }
    if (key.upArrow && fieldIndex > 0) {
      const nextValues = { ...values, [field.key]: value };
      const previous = FIELDS[fieldIndex - 1];
      const previousValue = nextValues[previous.key] ?? "";
      setValues(nextValues);
      setFieldIndex((index) => index - 1);
      setValue(previousValue);
      setCursor(previousValue.length);
      setError(null);
      return;
    }
    if (key.downArrow && fieldIndex < FIELDS.length - 1) {
      const nextValues = { ...values, [field.key]: value };
      const next = FIELDS[fieldIndex + 1];
      const nextValue = nextValues[next.key] ?? "";
      setValues(nextValues);
      setFieldIndex((index) => index + 1);
      setValue(nextValue);
      setCursor(nextValue.length);
      setError(null);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setValue(
        (current) => current.slice(0, cursor - 1) + current.slice(cursor),
      );
      setCursor((current) => current - 1);
      setError(null);
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      setCursor(0);
      setError(null);
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input && input.length > 0) {
      setValue(
        (current) => current.slice(0, cursor) + input + current.slice(cursor),
      );
      setCursor((current) => current + input.length);
      setError(null);
    }
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        skill proposal
        <Text color={theme.muted}> enter next/save | esc cancel</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={theme.success}>update</Text>
          {values.name && field.key !== "name" ? (
            <Text color={theme.muted}> {values.name}</Text>
          ) : null}
          <Text color={theme.muted}>
            {" "}
            {fieldIndex + 1}/{FIELDS.length}
          </Text>
        </Text>
        <Box>
          <Text color={theme.success}>
            {"> "}
            {field.label}:{" "}
          </Text>
          <RenderedLine value={value} cursor={cursor} />
          {!value ? <Text color={theme.muted}>{field.placeholder}</Text> : null}
        </Box>
        {error ? <Text color={theme.error}>{error}</Text> : null}
        <Text color={theme.muted}>up/down switch field | ctrl+u clear</Text>
      </Box>
    </DialogFrame>
  );
}

function validateField(key: FieldKey, value: string): string | null {
  if (key === "name" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    return "use lowercase letters, numbers, and hyphens";
  }
  if (key === "description" && value.trim().length === 0) {
    return "description is required";
  }
  return null;
}

function RenderedLine(props: {
  value: string;
  cursor: number;
}): React.ReactElement {
  const before = props.value.slice(0, props.cursor);
  const at = props.value.slice(props.cursor, props.cursor + 1) || " ";
  const after = props.value.slice(props.cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  );
}
