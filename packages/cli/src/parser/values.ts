export function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitCliWords(input: string): string[] {
  if (input.includes("\0")) {
    return input
      .split("\0")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return input
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
