// Internal generic object-access helpers shared by run.ts and its extracted
// modules (run-model-errors, run-validation, run-trace-build). Private to
// core — not surfaced through the public barrel. These deliberately treat
// arrays as non-records and walk a small set of well-known nested keys so
// provider error envelopes can be inspected without bespoke shape knowledge.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

export function getNumericProperty(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const property = value[key];
  return typeof property === "number" ? property : undefined;
}

export function getNestedStringProperty(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const direct = getStringProperty(value, key);
    if (direct !== undefined) return direct;
  }

  for (const nested of nestedRecords(value)) {
    const found = getNestedStringProperty(nested, keys);
    if (found !== undefined) return found;
  }

  return undefined;
}

export function getNestedNumericProperty(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const direct = getNumericProperty(value, key);
    if (direct !== undefined) return direct;
  }

  for (const nested of nestedRecords(value)) {
    const found = getNestedNumericProperty(nested, keys);
    if (found !== undefined) return found;
  }

  return undefined;
}

export function nestedRecords(
  value: Record<string, unknown>,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const knownNestedKeys = ["cause", "data", "error", "lastError"];

  for (const nested of Object.values(value)) {
    if (isRecord(nested)) records.push(nested);
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (isRecord(item)) records.push(item);
      }
    }
  }

  for (const key of knownNestedKeys) {
    const nested = value[key];
    if (isRecord(nested)) records.push(nested);
  }

  const errors = value.errors;
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (isRecord(error)) records.push(error);
    }
  }

  return records;
}

export function omitUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
