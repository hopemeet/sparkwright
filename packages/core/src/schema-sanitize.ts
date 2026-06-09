// Cross-backend tool JSON-schema sanitizer.
//
// Sparkwright is model-agnostic: the same tool schema is forwarded to cloud
// providers (Anthropic, OpenAI) and to local inference backends. Cloud
// providers silently accept schema shapes that strict local grammar
// generators (e.g. llama.cpp's json-schema-to-grammar) reject outright,
// failing the whole request. This pass normalizes the shapes we have seen
// cause trouble so a single schema is safe everywhere.
//
// Handled shapes:
//   * `anyOf` / `oneOf` unions whose only extra branch is `{type:"null"}`
//     (the common Pydantic / MCP "optional" shape) -> collapse to the
//     non-null branch, preserving sibling keys like `description`.
//   * array `type` such as `["string","null"]` -> drop `null`; collapse to a
//     single string when one type remains.
//   * `{type:"object"}` with no `properties` -> add an empty `properties` map
//     so grammar generators have something to constrain.
//   * malformed non-object schema values (e.g. `additionalProperties:"object"`
//     from a broken MCP server) -> dropped rather than forwarded.
//
// The function is pure and recursive; it never mutates its input.

import { isRecord } from "./record-utils.js";
function isNullSchema(node: unknown): boolean {
  return isRecord(node) && node.type === "null" && !("properties" in node);
}

/**
 * Normalize a tool input/output schema for broad LLM-backend compatibility.
 * Returns a sanitized copy; the input is left untouched.
 */
export function sanitizeToolSchema(schema: unknown): unknown {
  return sanitizeNode(schema);
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeNode);
  }
  if (!isRecord(node)) {
    // A bare scalar where a schema object was expected (malformed server
    // output). Leave primitives alone; callers strip these where they are
    // not valid (see `additionalProperties` below).
    return node;
  }

  let working: Record<string, unknown> = collapseNullableUnion(node);

  // The union collapse can fold a branch's keys in; re-read after it runs.
  working = { ...working };

  working = normalizeArrayType(working);

  // Recurse into every schema-bearing position.
  if (isRecord(working.properties)) {
    working.properties = Object.fromEntries(
      Object.entries(working.properties).map(([key, value]) => [
        key,
        sanitizeNode(value),
      ]),
    );
  }
  if (working.items !== undefined) {
    working.items = sanitizeNode(working.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(working[key])) {
      working[key] = (working[key] as unknown[]).map(sanitizeNode);
    }
  }
  if (isRecord(working.additionalProperties)) {
    working.additionalProperties = sanitizeNode(working.additionalProperties);
  } else if (
    working.additionalProperties !== undefined &&
    typeof working.additionalProperties !== "boolean"
  ) {
    // e.g. `additionalProperties: "object"` — not a valid schema or boolean.
    delete working.additionalProperties;
  }

  // An object schema with no constrainable properties trips strict grammar
  // generators; give them an explicit (empty) map.
  if (working.type === "object" && !isRecord(working.properties)) {
    working.properties = {};
  }

  return working;
}

/**
 * Collapse `anyOf` / `oneOf` unions that exist only to permit `null`.
 * Drops bare `{type:"null"}` branches; when a single branch remains its keys
 * are merged up into the parent (sibling keys like `description` win only
 * where the branch does not define them).
 */
function collapseNullableUnion(
  node: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;

    const nonNull = branches.filter((branch) => !isNullSchema(branch));
    if (nonNull.length === branches.length) continue; // no null branch present

    const { [key]: _dropped, ...rest } = node;

    if (nonNull.length === 1 && isRecord(nonNull[0])) {
      // Merge the surviving branch up, keeping parent siblings it lacks.
      const branch = nonNull[0];
      const merged: Record<string, unknown> = { ...branch };
      for (const [siblingKey, siblingValue] of Object.entries(rest)) {
        if (!(siblingKey in merged)) merged[siblingKey] = siblingValue;
      }
      return merged;
    }

    if (nonNull.length === 0) {
      // Degenerate union of only null branches; leave the node untouched.
      return node;
    }

    // Multiple real branches remain — keep the union, minus the null branch.
    return { ...rest, [key]: nonNull };
  }
  return node;
}

/**
 * Reduce array-valued `type` (e.g. `["string","null"]`). Drops `null`; when a
 * single type remains it is collapsed to a string. Multiple real types are
 * left as an array (we cannot safely pick one).
 */
function normalizeArrayType(
  node: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(node.type)) return node;

  const nonNull = node.type.filter((entry) => entry !== "null");
  if (nonNull.length === node.type.length) return node; // no null to drop

  if (nonNull.length === 1) {
    return { ...node, type: nonNull[0] };
  }
  if (nonNull.length === 0) {
    return node; // degenerate; leave as-is
  }
  return { ...node, type: nonNull };
}
