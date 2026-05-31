import React, { useEffect, useState } from "react";
import { Text } from "ink";

/**
 * Tiny braille spinner. Renders a single character that cycles every
 * `intervalMs`, and stops the timer when unmounted.
 *
 * Used in the status bar while a run is active. Kept self-contained so other
 * panels (e.g. session list "loading diagnostics") can drop one in.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(props: {
  color?: string;
  intervalMs?: number;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % FRAMES.length),
      props.intervalMs ?? 160,
    );
    return () => clearInterval(id);
  }, [props.intervalMs]);
  return <Text color={props.color}>{FRAMES[frame]}</Text>;
}
