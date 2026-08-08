import type { Key } from "ink";
import {
  chordMatches,
  shouldDeferPrintableChordToInput,
  type Chord,
} from "./keybindings.js";

export type InputScope =
  | "blocking-decision"
  | "dialog"
  | "composer-overlay"
  | "composer-editor"
  | "global";

export interface InteractionAction {
  id: string;
  scope: InputScope;
  chords: readonly Chord[];
  enabled: boolean;
  run(): void;
}

export interface InteractionResult {
  handled: boolean;
  scope?: InputScope;
}

/**
 * Pure handled/bubble router. InputBox calls it only after an active composer
 * overlay declines a key, so one Ink listener owns editor + global routing.
 */
export class InteractionRouter {
  route(
    input: string,
    key: Key,
    draft: string,
    actions: readonly InteractionAction[],
  ): InteractionResult {
    for (const action of actions) {
      if (!action.enabled) continue;
      if (shouldDeferPrintableChordToInput(action.chords, key, input, draft)) {
        continue;
      }
      if (!action.chords.some((chord) => chordMatches(chord, key, input))) {
        continue;
      }
      action.run();
      return { handled: true, scope: action.scope };
    }
    return { handled: false };
  }
}
