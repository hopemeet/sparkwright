/**
 * Render an event stream as a human-readable markdown transcript.
 *
 * We walk events chronologically and group them into sections by intent:
 *   - run.started               → header
 *   - user goal (from run.started.payload.goal)
 *   - model.stream.chunk(text)  → assembled into one "Assistant" block per
 *                                 stream lifecycle
 *   - tool.requested/completed  → ### Tool sections with args + result
 *   - workspace.write.applied   → fenced diff block
 *   - approval.requested/resolved → admin note
 *   - run.completed/failed      → footer
 *
 * Unknown events fall through to a compact "raw" list at the end so the
 * export is lossless without being overwhelming.
 */

import type { RunEvent } from "./event-type.js";

export interface TranscriptHeader {
  sessionId: string;
  workspaceRoot: string;
  model?: string;
  exportedAt?: Date;
}

export function renderTranscript(
  header: TranscriptHeader,
  events: RunEvent[],
): string {
  const exportedAt = header.exportedAt ?? new Date();
  const out: string[] = [];

  out.push(`# Sparkwright session ${header.sessionId}`);
  out.push("");
  out.push(`- **Workspace:** \`${header.workspaceRoot}\``);
  if (header.model) out.push(`- **Model:** \`${header.model}\``);
  out.push(`- **Exported:** ${exportedAt.toISOString()}`);
  out.push(`- **Events:** ${events.length}`);
  out.push("");
  out.push("---");
  out.push("");

  // Streaming text is assembled across model.stream.chunk events between
  // model.stream.started and model.stream.completed. We keep buffers per
  // run so concurrent streams don't cross-contaminate (rare today, future-proof).
  const streamBuffers = new Map<string, string>();

  const tail: RunEvent[] = []; // events we didn't render as a section

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const runId = typeof p.runId === "string" ? p.runId : "main";

    switch (ev.type) {
      case "run.started": {
        const goal = typeof p.goal === "string" ? p.goal : "";
        out.push(`## User`);
        out.push("");
        out.push(goal || "_(no goal text)_");
        out.push("");
        break;
      }
      case "model.stream.started": {
        streamBuffers.set(runId, "");
        break;
      }
      case "model.stream.chunk": {
        const chunk = p as { type?: string; text?: string };
        if (chunk.type === "text_delta" && typeof chunk.text === "string") {
          streamBuffers.set(
            runId,
            (streamBuffers.get(runId) ?? "") + chunk.text,
          );
        }
        break;
      }
      case "model.stream.completed": {
        const text = streamBuffers.get(runId) ?? "";
        streamBuffers.delete(runId);
        if (text) {
          out.push(`## Assistant`);
          out.push("");
          out.push(text.trimEnd());
          out.push("");
        }
        break;
      }
      // A concurrent/sequential tool batch wraps the child tool sections below.
      // We emit a heading so the export shows the grouping; the matching
      // `tool.batch.completed` closes it with a delimiter. The child
      // tool.requested/completed sections render normally between the two.
      case "tool.batch.requested": {
        const count =
          typeof p.toolCallCount === "number"
            ? p.toolCallCount
            : Array.isArray(p.toolNames)
              ? p.toolNames.length
              : 0;
        const mode = typeof p.mode === "string" ? p.mode : "concurrent";
        out.push(
          `### Batch · ${count} tool${count === 1 ? "" : "s"} (${mode})`,
        );
        out.push("");
        break;
      }
      case "tool.batch.completed": {
        out.push("_End of batch._");
        out.push("");
        break;
      }
      case "tool.requested": {
        const name = typeof p.toolName === "string" ? p.toolName : "?";
        out.push(`### Tool: \`${name}\``);
        const args = p.input ?? p.args;
        if (args !== undefined) {
          out.push("");
          out.push("```json");
          out.push(safeJson(args));
          out.push("```");
        }
        out.push("");
        break;
      }
      case "tool.completed": {
        const name = typeof p.toolName === "string" ? p.toolName : "?";
        const result = p.result ?? p.output;
        if (result !== undefined) {
          out.push(`_Result of \`${name}\`:_`);
          out.push("");
          out.push("```");
          out.push(typeof result === "string" ? result : safeJson(result));
          out.push("```");
          out.push("");
        }
        break;
      }
      case "tool.failed": {
        const name = typeof p.toolName === "string" ? p.toolName : "?";
        const err =
          typeof p.error === "object" && p.error !== null
            ? safeJson(p.error)
            : String(p.error ?? "");
        out.push(`> ⚠ Tool \`${name}\` failed: ${err}`);
        out.push("");
        break;
      }
      case "workspace.write.applied":
      case "workspace.write.completed": {
        const path = typeof p.path === "string" ? p.path : "?";
        out.push(`### Write: \`${path}\``);
        if (typeof p.diff === "string" && p.diff.length > 0) {
          out.push("");
          out.push("```diff");
          out.push(p.diff.trimEnd());
          out.push("```");
        }
        out.push("");
        break;
      }
      case "workspace.write.denied": {
        const path = typeof p.path === "string" ? p.path : "?";
        const reason = typeof p.reason === "string" ? p.reason : "";
        out.push(
          `> 🚫 Write denied: \`${path}\`${reason ? ` — ${reason}` : ""}`,
        );
        out.push("");
        break;
      }
      case "approval.requested": {
        const summary = typeof p.summary === "string" ? p.summary : "?";
        out.push(`> 🤝 Approval requested: ${summary}`);
        out.push("");
        break;
      }
      case "approval.resolved": {
        const decision = typeof p.decision === "string" ? p.decision : "?";
        out.push(`> Approval ${decision}`);
        out.push("");
        break;
      }
      case "run.completed": {
        const stopReason =
          typeof p.stopReason === "string" ? p.stopReason : "completed";
        out.push("---");
        out.push("");
        out.push(`_Run completed: **${stopReason}**_`);
        out.push("");
        break;
      }
      case "run.failed": {
        const err =
          typeof p.error === "object" &&
          p.error !== null &&
          "message" in p.error
            ? String((p.error as { message: unknown }).message)
            : safeJson(p.error);
        out.push("---");
        out.push("");
        out.push(`_Run failed: **${err}**_`);
        out.push("");
        break;
      }
      default:
        tail.push(ev);
    }
  }

  if (tail.length > 0) {
    out.push("");
    out.push("---");
    out.push("");
    out.push(`<details><summary>Raw events (${tail.length})</summary>`);
    out.push("");
    out.push("```");
    for (const ev of tail) {
      out.push(`[${ev.sequence ?? "?"}] ${ev.type}`);
    }
    out.push("```");
    out.push("");
    out.push("</details>");
  }

  return out.join("\n") + "\n";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Return the text of the most recent assistant turn, or null if there isn't
 * one. `model.completed` (and the eager-tool `model.assistant_text`) carry the
 * final text at `payload.message` for both providers; we scan backward so the
 * latest reply wins. Used by /copy to put the answer on the clipboard.
 */
export function lastAssistantMessage(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "model.completed" && ev.type !== "model.assistant_text") {
      continue;
    }
    const message = (ev.payload as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}
