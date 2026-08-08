import React, { useMemo } from "react";
import { Box, useStdout } from "ink";
import { TranscriptPhysicalRow } from "./transcript-viewport.js";
import type { RunEvent } from "../lib/event-type.js";
import { assembleTranscriptDocument } from "../lib/transcript-document.js";
import { layoutTranscriptDocument } from "../lib/transcript-layout.js";
import type { ToolDisplayTone } from "../lib/tool-display.js";

export { oneLine } from "../lib/tool-display.js";

export interface TranscriptHeaderInfo {
  workspaceRoot: string;
  modelLabel: string;
  sessionId: string | null;
}

/** @internal Semantic tone shared by task lifecycle tests and projections. */
export function taskTerminalTone(status: string): ToolDisplayTone {
  if (status === "completed") return "success";
  if (status === "cancelled") return "warning";
  if (status === "failed") return "error";
  return "normal";
}

/**
 * Compatibility surface for embedders and compact-render characterization
 * tests. Runtime App uses TranscriptViewport, but both paths consume the same
 * TranscriptDocument and physical layout; this component is not a second
 * presentation implementation and deliberately contains no <Static>.
 */
export function EventStream(props: {
  events: RunEvent[];
  header: TranscriptHeaderInfo;
}): React.ReactElement {
  const { stdout } = useStdout();
  const document = useMemo(
    () =>
      assembleTranscriptDocument({
        epoch: "event-stream-compat",
        events: props.events,
        header: props.header,
      }),
    [props.events, props.header],
  );
  const layout = useMemo(
    () =>
      layoutTranscriptDocument(
        document,
        "compact",
        Math.max(1, stdout?.columns ?? 120),
      ),
    [document, stdout?.columns],
  );
  return (
    <Box flexDirection="column">
      {layout.rows.map((row) => (
        <TranscriptPhysicalRow key={row.key} row={row} />
      ))}
    </Box>
  );
}
