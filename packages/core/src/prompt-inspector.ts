// =============================================================================
// prompt-inspector.ts — Runtime injection scan over the *final* prompt.
//
// Why this lives at prompt-builder boundary, not at content ingestion:
// scanning user input on the way in misses payloads that ride in through
// skills, MCP-loaded capabilities, memory entries, or tool descriptors —
// anything that gets composed into the prompt at runtime.
//
// The scan point must be "after PromptBuilder finishes, before send to
// model". `wrapPromptBuilderWithInspector` does exactly that: it runs
// the wrapped builder, walks the produced PromptMessage[] through an
// inspector, and either passes the messages along, augments them with a
// warning section, or throws a `PromptInspectionBlocked` so the run
// loop refuses to send the prompt.
//
// The default inspector is built on top of the existing ContentPolicy
// surface — so any custom rules already wired up for memory_write /
// skill_body protection automatically apply at the prompt boundary too.
// =============================================================================

import type { ContentPolicy, ContentSource } from "./content-policy.js";
import { createDefaultContentPolicy } from "./content-policy.js";
import type {
  PromptBuilder,
  PromptBuildInput,
  PromptMessage,
} from "./context.js";

export interface PromptInspectionFinding {
  ruleId: string;
  reason: string;
  /** @reserved Public prompt-inspection index consumed by diagnostics UIs. */
  messageIndex: number;
  /** `role` of the offending message, when applicable. */
  role?: PromptMessage["role"];
  /**
   * `sectionName` recorded on the message metadata, when the prompt was
   * built by `SectionedPromptBuilder`. Lets diagnostics point at the
   * specific section that introduced the payload.
   */
  sectionName?: string;
}

export type PromptInspectionVerdict =
  | { kind: "ok" }
  | { kind: "warn"; findings: PromptInspectionFinding[] }
  | { kind: "block"; findings: PromptInspectionFinding[] };

export interface PromptInspector {
  readonly name: string;
  inspect(
    messages: PromptMessage[],
    input: PromptBuildInput,
  ): PromptInspectionVerdict | Promise<PromptInspectionVerdict>;
}

/**
 * Thrown by {@link wrapPromptBuilderWithInspector} when the inspector
 * returns `{ kind: "block" }`. The run loop should treat this as a
 * non-retryable failure: re-running the same step would re-trigger the
 * scan. Hosts typically surface the findings to the user verbatim so
 * they can edit the offending skill / memory entry.
 *
 * @public
 * @stability experimental v0.1
 */
export class PromptInspectionBlocked extends Error {
  readonly findings: PromptInspectionFinding[];
  readonly inspectorName: string;

  constructor(inspectorName: string, findings: PromptInspectionFinding[]) {
    const summary = findings
      .map((f) => `[${f.ruleId}] ${f.reason}`)
      .slice(0, 5)
      .join("; ");
    super(
      `Prompt inspection blocked by ${inspectorName}: ${summary || "no findings"}`,
    );
    this.name = "PromptInspectionBlocked";
    this.findings = findings;
    this.inspectorName = inspectorName;
  }
}

export interface CreateDefaultPromptInspectorOptions {
  /**
   * Override the content policy. When omitted, uses
   * `createDefaultContentPolicy()`.
   */
  policy?: ContentPolicy;
  /**
   * Map a `PromptMessage` to the {@link ContentSource} value used during
   * policy evaluation. Defaults to `"tool_result"` for `role: "tool"`,
   * `"user_input"` for `role: "user"`, and `"skill_body"` otherwise.
   */
  sourceForMessage?: (message: PromptMessage) => ContentSource;
  name?: string;
}

/**
 * Build an inspector backed by a {@link ContentPolicy}. Findings are
 * grouped into block / warn based on the policy verdict.
 *
 * @public
 * @stability experimental v0.1
 */
export function createDefaultPromptInspector(
  options: CreateDefaultPromptInspectorOptions = {},
): PromptInspector {
  const policy = options.policy ?? createDefaultContentPolicy();
  const sourceForMessage = options.sourceForMessage ?? defaultSourceForMessage;
  const name = options.name ?? "default_prompt_inspector";

  return {
    name,
    inspect(messages) {
      const blockFindings: PromptInspectionFinding[] = [];
      const warnFindings: PromptInspectionFinding[] = [];
      for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i]!;
        const verdict = policy.evaluate(
          message.content,
          sourceForMessage(message),
        );
        const sectionName = readSectionName(message);
        for (const block of verdict.blocks) {
          blockFindings.push({
            ruleId: block.ruleId,
            reason: block.reason,
            messageIndex: i,
            role: message.role,
            sectionName,
          });
        }
        for (const warn of verdict.warnings) {
          warnFindings.push({
            ruleId: warn.ruleId,
            reason: warn.reason,
            messageIndex: i,
            role: message.role,
            sectionName,
          });
        }
      }
      if (blockFindings.length > 0) {
        return { kind: "block", findings: [...blockFindings, ...warnFindings] };
      }
      if (warnFindings.length > 0) {
        return { kind: "warn", findings: warnFindings };
      }
      return { kind: "ok" };
    },
  };
}

function defaultSourceForMessage(message: PromptMessage): ContentSource {
  if (message.role === "tool") return "tool_result";
  if (message.role === "user") return "user_input";
  return "skill_body";
}

function readSectionName(message: PromptMessage): string | undefined {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const value = meta?.["sectionName"];
  return typeof value === "string" ? value : undefined;
}

export interface WrapPromptBuilderOptions {
  /**
   * Behaviour when the inspector returns `{ kind: "warn" }`.
   *
   * - `"pass"` (default): proceed with the original prompt; the host may
   *   observe warnings via `onVerdict`.
   * - `"throw"`: treat warnings like blocks and throw
   *   `PromptInspectionBlocked`.
   */
  onWarn?: "pass" | "throw";
  /**
   * Optional observer invoked after every inspection, including the OK
   * case. Useful for trace event emission.
   */
  onVerdict?: (verdict: PromptInspectionVerdict) => void;
}

/**
 * Wrap a {@link PromptBuilder} so its output is inspected before being
 * returned to the run loop. Throws {@link PromptInspectionBlocked} when
 * the inspector blocks. Output is otherwise unchanged.
 *
 * @public
 * @stability experimental v0.1
 */
export function wrapPromptBuilderWithInspector<TOutput extends PromptMessage[]>(
  builder: PromptBuilder<TOutput>,
  inspector: PromptInspector,
  options: WrapPromptBuilderOptions = {},
): PromptBuilder<TOutput> {
  const onWarn = options.onWarn ?? "pass";
  return {
    async build(input) {
      const built = await builder.build(input);
      const verdict = await inspector.inspect(built, input);
      options.onVerdict?.(verdict);
      if (verdict.kind === "block") {
        throw new PromptInspectionBlocked(inspector.name, verdict.findings);
      }
      if (verdict.kind === "warn" && onWarn === "throw") {
        throw new PromptInspectionBlocked(inspector.name, verdict.findings);
      }
      return built;
    },
  };
}
