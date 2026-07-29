import { defineTool, type ToolDefinition } from "@sparkwright/core";
import {
  AGENT_OUTCOME_SCHEMA_VERSION,
  agentResultDeclarationFromUnknown,
} from "./result.js";
import type { AgentResultDeclaration } from "./types.js";

export const SUBMIT_AGENT_RESULT_TOOL_NAME = "submit_agent_result";

export function createSubmitAgentResultTool(): ToolDefinition<
  Omit<AgentResultDeclaration, "schemaVersion">,
  AgentResultDeclaration
> {
  return defineTool({
    name: SUBMIT_AGENT_RESULT_TOOL_NAME,
    description:
      "Submit a structured partial or blocked child outcome when the parent needs recovery facts. A completed goal should normally finish with one natural-language report; status completed remains accepted for compatibility. This must be the sole tool call in the response and ends the child run atomically. You may include a human-readable report as assistant text in the same response.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed", "partial", "blocked"],
        },
        summary: { type: "string" },
        accomplishments: {
          type: "array",
          items: { type: "string" },
        },
        blockers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              code: { type: "string" },
              kind: {
                type: "string",
                enum: [
                  "capability",
                  "permission",
                  "user_input",
                  "dependency",
                  "resource_limit",
                  "conflict",
                  "protocol",
                  "unknown",
                ],
              },
              owner: {
                type: "string",
                enum: ["parent", "user", "runtime", "external"],
              },
              message: { type: "string" },
              requirements: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: [
                        "tool",
                        "approval",
                        "input",
                        "dependency",
                        "resource",
                      ],
                    },
                    name: { type: "string" },
                  },
                  required: ["kind", "name"],
                  additionalProperties: false,
                },
              },
              retry: {
                type: "string",
                enum: [
                  "none",
                  "immediate",
                  "after_input",
                  "after_approval",
                  "after_capability_change",
                  "after_dependency_change",
                  "after_resource_change",
                ],
              },
            },
            required: ["code", "kind", "owner", "message", "retry"],
            additionalProperties: false,
          },
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
    delegation: "parent_only",
    terminal: {
      kind: "agent_result",
      renderMessage: (output) => output.summary,
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "@sparkwright/agent-runtime" },
      sideEffects: ["none"],
      idempotency: "non_idempotent",
    },
    validateInput(args) {
      const declaration = agentResultDeclarationFromUnknown({
        schemaVersion: AGENT_OUTCOME_SCHEMA_VERSION,
        ...args,
      });
      return declaration
        ? { ok: true }
        : {
            ok: false,
            code: "AGENT_RESULT_PROTOCOL_INVALID",
            message:
              "submit_agent_result requires a valid status and non-empty summary; optional details must satisfy agent-outcome.v1.",
          };
    },
    execute(args) {
      const declaration = agentResultDeclarationFromUnknown({
        schemaVersion: AGENT_OUTCOME_SCHEMA_VERSION,
        ...args,
      });
      if (!declaration) {
        throw Object.assign(
          new Error("Invalid agent-outcome.v1 terminal result."),
          { code: "AGENT_RESULT_PROTOCOL_INVALID" },
        );
      }
      return declaration;
    },
  });
}
