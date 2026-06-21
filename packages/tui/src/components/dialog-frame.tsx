import React from "react";
import { Box, useStdout } from "ink";

export const DIALOG_MAX_WIDTH = 88;
export const DIALOG_MIN_WIDTH = 20;

export function dialogFrameWidth(columns: number | undefined): number {
  const available = Math.max(DIALOG_MIN_WIDTH, (columns ?? 100) - 2);
  return Math.min(DIALOG_MAX_WIDTH, available);
}

export function resolveDialogColumns(
  stdoutColumns: number | undefined,
): number | undefined {
  const envColumns = Number.parseInt(process.env.COLUMNS ?? "", 10);
  const hasEnvColumns = Number.isFinite(envColumns) && envColumns > 0;
  if (
    hasEnvColumns &&
    (stdoutColumns === undefined ||
      stdoutColumns <= 0 ||
      (stdoutColumns < 40 && envColumns >= 40))
  ) {
    return envColumns;
  }
  return stdoutColumns;
}

export function DialogFrame(props: {
  borderColor: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { stdout } = useStdout();
  const columns = resolveDialogColumns(stdout?.columns);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.borderColor}
      paddingX={1}
      width={dialogFrameWidth(columns)}
      flexShrink={0}
    >
      {props.children}
    </Box>
  );
}
