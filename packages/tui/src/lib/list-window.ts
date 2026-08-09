/** Keep the active row visible while bounding a list to a terminal-sized window. */
export function windowAroundCursor<T>(
  items: readonly T[],
  cursor: number,
  windowSize: number,
): { start: number; visible: readonly T[] } {
  const size = Math.max(1, windowSize);
  const safeCursor = Math.max(
    0,
    Math.min(cursor, Math.max(0, items.length - 1)),
  );
  const start = Math.max(
    0,
    Math.min(items.length - size, safeCursor - Math.floor(size / 2)),
  );
  return { start, visible: items.slice(start, start + size) };
}
