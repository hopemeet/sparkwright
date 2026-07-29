/**
 * Ink 5 clears and rewrites the entire terminal whenever its output height is
 * greater than or equal to stdout.rows. Keep one physical row outside Ink's
 * owned tree so ordinary state updates stay on its incremental render path.
 */
export const INK_BOTTOM_ROW_RESERVE = 1;

export function inkScreenRows(terminalRows: number | undefined): number {
  const rows =
    typeof terminalRows === "number" && Number.isFinite(terminalRows)
      ? Math.max(1, Math.floor(terminalRows))
      : 24;
  return Math.max(1, rows - INK_BOTTOM_ROW_RESERVE);
}
