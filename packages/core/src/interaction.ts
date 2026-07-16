// =============================================================================
// AI maintenance note
//
// InteractionChannel is the unified outbound channel from the runtime to a
// user (CLI prompt, desktop modal, Slack/Feishu DM, web UI, etc.). It
// covers the three outbound shapes that embedders consistently need:
//
//   - `approve`  → yes/no decision on a risky action.
//   - `ask`      → free-form or multiple-choice question for the user.
//   - `notify`   → fire-and-forget status / warning / error message.
//
// `approve` is wired into the core run loop. `ask` and `notify` are surfaced on
// `RunHandle.askUser()` / `RunHandle.notifyUser()` so tools and hooks can
// reach the user without each integrator inventing its own channel.
//
// See docs/EXTENSION_INTERFACES.md "Interaction Channel".
// =============================================================================

import { createId } from "./ids.js";
import type { RunId } from "./ids.js";
import type { ApprovalRequest, ApprovalResponse } from "./types.js";

/**
 * One fixed choice on a structured question. `preview` is reserved for
 * frontends that want to render a side panel (code snippet, mockup, etc.)
 * when the choice is focused; `description` is the short explanation under
 * the label.
 *
 * @public
 * @stability experimental v0.1
 */
export interface InteractionQuestionChoice {
  id: string;
  /** @reserved Public field consumed by UI frontends. */
  label: string;
  description?: string;
  /**
   * Optional preview content (markdown, code snippet, mockup) rendered when
   * the choice is focused. Frontends that don't support previews ignore this.
   *
   * @reserved Public field consumed by UI frontends.
   */
  preview?: string;
}

export interface InteractionQuestionRequest {
  id: string;
  runId: RunId;
  /**
   * Short label / chip-style tag for the question (≤ 12 chars recommended).
   * Distinct from `prompt` which is the full question text. Modelled after
   * structured-question UIs that show a category chip above the question.
   *
   * @reserved Public field consumed by UI frontends.
   */
  header?: string;
  prompt: string;
  /**
   * Optional fixed-choice options. When supplied, the channel SHOULD constrain
   * the user's input to one of these values. The returned `value` must match
   * one of the option ids; an empty string means "no choice / cancelled".
   */
  choices?: InteractionQuestionChoice[];
  /**
   * When true, the user may select multiple options. The response's
   * `selectedChoiceIds` MUST be populated; `value` is a comma-joined fallback
   * for legacy channels.
   */
  multiSelect?: boolean;
  /**
   * Optional default option id (must match a `choices[].id`). Used by
   * non-interactive embedders (CI, batch jobs) that auto-resolve questions.
   */
  defaultChoiceId?: string;
  metadata?: Record<string, unknown>;
}

export interface InteractionQuestionResponse {
  id: string;
  /**
   * Free-form value or, for choice questions, the chosen `choices[].id`. For
   * `multiSelect: true` requests this is a comma-joined fallback; prefer
   * reading `selectedChoiceIds` directly.
   */
  value: string;
  /**
   * Populated for `multiSelect: true` requests with the set of chosen
   * `choices[].id` values. Optional for single-choice and free-form responses.
   *
   * @reserved Public field consumed by UI frontends and approval brokers.
   */
  selectedChoiceIds?: string[];
  /**
   * Free-form annotation the user added to their selection (e.g. notes
   * attached to a structured choice).
   *
   * @reserved Public field consumed by UI frontends.
   */
  notes?: string;
  metadata?: Record<string, unknown>;
}

export type InteractionNotificationLevel = "info" | "warn" | "error";

export interface InteractionNotification {
  id: string;
  runId: RunId;
  level: InteractionNotificationLevel;
  message: string;
  /**
   * Optional short title for systems that distinguish title from body
   * (e.g. desktop OS notifications, Slack/Feishu cards).
   */
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface InteractionChannel {
  approve?(
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> | ApprovalResponse;
  ask?(
    request: InteractionQuestionRequest,
  ): Promise<InteractionQuestionResponse> | InteractionQuestionResponse;
  notify?(notification: InteractionNotification): void | Promise<void>;
}

export function createInteractionQuestionRequest(input: {
  runId: RunId;
  prompt: string;
  header?: string;
  choices?: InteractionQuestionRequest["choices"];
  multiSelect?: boolean;
  defaultChoiceId?: string;
  metadata?: Record<string, unknown>;
}): InteractionQuestionRequest {
  return {
    id: createId("intq"),
    runId: input.runId,
    header: input.header,
    prompt: input.prompt,
    choices: input.choices,
    multiSelect: input.multiSelect,
    defaultChoiceId: input.defaultChoiceId,
    metadata: input.metadata,
  };
}

export function createInteractionNotification(input: {
  runId: RunId;
  level: InteractionNotificationLevel;
  message: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): InteractionNotification {
  return {
    id: createId("intn"),
    runId: input.runId,
    level: input.level,
    message: input.message,
    title: input.title,
    metadata: input.metadata,
  };
}
