import { describe, expect, it } from "vitest";
import { sanitizeToolSchema } from "../src/schema-sanitize.js";

describe("sanitizeToolSchema", () => {
  it("collapses anyOf null-unions to the non-null branch, keeping siblings", () => {
    expect(
      sanitizeToolSchema({
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "an optional name",
      }),
    ).toEqual({
      type: "string",
      description: "an optional name",
    });
  });

  it("collapses oneOf null-unions the same way", () => {
    expect(
      sanitizeToolSchema({
        oneOf: [{ type: "null" }, { type: "integer", minimum: 0 }],
      }),
    ).toEqual({ type: "integer", minimum: 0 });
  });

  it("keeps multi-branch unions but drops the null branch", () => {
    expect(
      sanitizeToolSchema({
        anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
      }),
    ).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("reduces array type to a single string when only one survives", () => {
    expect(sanitizeToolSchema({ type: ["string", "null"] })).toEqual({
      type: "string",
    });
  });

  it("keeps multiple real types as an array, dropping null", () => {
    expect(sanitizeToolSchema({ type: ["string", "number", "null"] })).toEqual({
      type: ["string", "number"],
    });
  });

  it("adds an empty properties map to bare object schemas", () => {
    expect(sanitizeToolSchema({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("drops malformed non-boolean additionalProperties", () => {
    expect(
      sanitizeToolSchema({
        type: "object",
        properties: {},
        additionalProperties: "object",
      }),
    ).toEqual({ type: "object", properties: {} });
  });

  it("recurses into nested properties and array items", () => {
    expect(
      sanitizeToolSchema({
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          nested: { type: "object" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: {} },
      },
    });
  });

  it("leaves already-valid schemas unchanged", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it("does not mutate its input", () => {
    const schema = {
      type: "object",
      properties: { a: { type: ["string", "null"] } },
    };
    const snapshot = JSON.parse(JSON.stringify(schema));
    sanitizeToolSchema(schema);
    expect(schema).toEqual(snapshot);
  });

  it("passes scalar (malformed) schema values through untouched", () => {
    expect(sanitizeToolSchema("object")).toBe("object");
  });
});
